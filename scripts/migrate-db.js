#!/usr/bin/env node
const { db } = require('../server/db');
const { LATEST_SCHEMA_VERSION } = require('../server/migrations');

console.log(`数据库迁移完成，schema version=${LATEST_SCHEMA_VERSION}`);
db.close();
