#!/usr/bin/env node
/**
 * AI 工具每日签到 —— CLI 入口（薄壳：参数解析 → lib/runner）
 *
 * 工具实现在 lib/tools/（自动发现，加新工具放一个文件即可）；
 * 账号快照与 token 缓存在 data/（由 lib/core/store.js 管理，首次运行自动迁移旧布局）。
 *
 * 用法：
 *   node checkin.js                        # 全部工具全部账号签到（计划任务路径）
 *   node checkin.js --list [<tool>]        # 账号总览（token 剩余天数）
 *   node checkin.js --save <tool> <名称>   # 导入客户端当前登录账号为快照
 *   node checkin.js --remove <tool> <名称> # 删除账号快照
 *   node checkin.js --run <tool>           # 只跑某一个工具
 *
 * tool 取值见 lib/tools/ 下各模块的 key（当前：workbuddy / traework / qoder）。
 * 退出码：0 全部成功（含"今日已签"）；1 有失败项；2 用法错误。
 */

'use strict';

const store = require('./lib/core/store');
const runner = require('./lib/core/runner');
const { log } = require('./lib/core/log');

process.on('uncaughtException', (e) => {
  log(`未预期错误: ${e.stack || e.message}`);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  log(`未预期错误: ${e && e.message ? e.message : e}`);
  process.exit(1);
});

const USAGE = [
  '用法:',
  '  node checkin.js                        # 全部工具全部账号签到',
  '  node checkin.js --list [<tool>]        # 账号总览（token 剩余天数）',
  '  node checkin.js --save <tool> <名称>   # 导入客户端当前登录账号为快照',
  '  node checkin.js --remove <tool> <名称> # 删除账号快照',
  '  node checkin.js --run <tool>           # 只跑某一个工具',
  '  node checkin.js --help',
  '',
  'tool 取值见 lib/tools/ 各模块的 key（当前: workbuddy / traework / qoder）',
].join('\n');

function usageError() {
  console.error(USAGE);
  process.exitCode = 2;
}

function fmtDays(days, unit) {
  if (days === null || days === undefined) return '未知';
  return days > 0 ? `剩 ${days} ${unit}` : `已过期（签到时会自动续期）`;
}

async function cmdList(toolKey) {
  const tools = toolKey ? [runner.getTool(toolKey)] : runner.loadTools();
  for (const tool of tools) {
    const accs = await tool.collectAccounts();
    if (!accs.length) {
      log(`[${tool.name}] ${tool.noAccountMsg}`);
      continue;
    }
    log(`[${tool.name}] 共 ${accs.length} 个账号：`);
    for (const a of accs) {
      log(
        `  - ${a.name}  uid=${a.uid || '?'}  来源=${a.source === 'app' ? '客户端登录' : '快照'}  ` +
          `token ${fmtDays(a.tokenExpireDays, '天')}  refreshToken ${fmtDays(a.refreshTokenExpireDays, '天')}`
      );
    }
  }
}

async function runAndReport(scope, toolKey) {
  log(`=== AI 工具每日签到开始${toolKey ? `（${toolKey}）` : ''} ===`);
  const results = await scope();
  const fail = results.filter((r) => !r.ok).length;
  log(`=== 签到结束${fail === 0 ? '，全部成功' : `，${fail} 项失败`} ===`);
  process.exitCode = fail === 0 ? 0 : 1;
}

async function main() {
  store.init(); // 建目录 + 旧数据迁移（幂等）

  const argv = process.argv.slice(2);
  if (!argv.length) {
    await runAndReport(() => runner.runAll(), null);
    return;
  }

  const cmd = argv[0];
  if (cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    return;
  }
  if (cmd === '--list') {
    const toolKey = argv[1];
    if (toolKey && !runner.getTool(toolKey)) return usageError();
    await cmdList(toolKey);
    return;
  }
  if (cmd === '--save' || cmd === '--remove') {
    const toolKey = argv[1];
    const name = argv[2];
    if (!toolKey || !name) return usageError();
    const tool = runner.getTool(toolKey);
    if (!tool) return usageError();
    const r = await tool[cmd === '--save' ? 'importAccount' : 'removeAccount'](name);
    log(`[${tool.name}] ${r.ok ? '✅' : '❌'} ${r.msg}`);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  if (cmd === '--run') {
    const toolKey = argv[1];
    if (!toolKey) return usageError();
    if (!runner.getTool(toolKey)) return usageError();
    await runAndReport(() => runner.runTool(toolKey), toolKey);
    return;
  }
  usageError();
}

main();
