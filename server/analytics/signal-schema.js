function tableExists(db, table) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table));
}

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
}

/**
 * Columns for confirming a person and naming the network a visit came from. Added in place on
 * every start, so existing databases need no maintenance window.
 *
 * - access_metrics.confirmed_at / access_event_details.interacted_at: when the page script
 *   reported a real pointer, touch, wheel or key event. NULL means not confirmed.
 * - access_event_details.asn / as_org / network_kind: the IP's autonomous system and whether it
 *   is a consumer ISP or a hosting, cloud or VPN network.
 */
function migrateAnalyticsSignalSchema(db) {
  if (tableExists(db, 'access_metrics') && !columnNames(db, 'access_metrics').has('confirmed_at')) {
    db.exec('ALTER TABLE access_metrics ADD COLUMN confirmed_at TEXT');
  }
  if (!tableExists(db, 'access_event_details')) return;
  const columns = columnNames(db, 'access_event_details');
  if (!columns.has('interacted_at')) {
    db.exec('ALTER TABLE access_event_details ADD COLUMN interacted_at TEXT');
  }
  if (!columns.has('asn')) db.exec('ALTER TABLE access_event_details ADD COLUMN asn INTEGER');
  if (!columns.has('as_org')) db.exec('ALTER TABLE access_event_details ADD COLUMN as_org TEXT');
  if (!columns.has('network_kind')) {
    db.exec("ALTER TABLE access_event_details ADD COLUMN network_kind TEXT CHECK (network_kind IN ('isp', 'hosting'))");
  }
}

module.exports = { migrateAnalyticsSignalSchema };
