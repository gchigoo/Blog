#!/usr/bin/env node
/**
 * 查看与解除 IP 封禁
 * 用法: node scripts/ip-bans.js            列出最近 50 条
 *       node scripts/ip-bans.js list 200   列出最近 200 条
 *       node scripts/ip-bans.js unban <IPv4 | IPv6 | IPv6/64>
 * 运行中的服务每 60 秒重新读取封禁列表，解除后最多 1 分钟生效。
 */

const Database = require('better-sqlite3');
const path = require('path');
const { initializeIpBans, listIpBans, removeIpBan } = require('../server/security/ip-bans');
const { requestedNetwork } = require('../server/security/admin-api');

const [command = 'list', argument] = process.argv.slice(2);
const db = new Database(path.join(__dirname, '../blog.db'));
db.pragma('busy_timeout = 5000');

try {
  initializeIpBans(db);
  if (command === 'list') {
    const limit = /^\d{1,4}$/.test(argument || '') ? Number(argument) : 50;
    const { total, bans } = listIpBans(db, limit);
    console.log(`共 ${total} 个封禁${total > bans.length ? `，显示最近 ${bans.length} 个` : ''}`);
    for (const ban of bans) {
      console.log([
        ban.createdAt.slice(0, 19).replace('T', ' '),
        ban.network.padEnd(24),
        ban.country || '--',
        `${ban.method} ${ban.path} → ${ban.status}`,
        `之后被拦 ${ban.hits} 次`
      ].join('  '));
    }
  } else if (command === 'unban') {
    const network = requestedNetwork(argument);
    if (!network) throw new Error('需要一个 IPv4、IPv6 地址或 IPv6 /64');
    console.log(removeIpBan(db, network) ? `已解除 ${network}` : `${network} 没有被封禁`);
  } else {
    throw new Error(`未知命令 ${command}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
