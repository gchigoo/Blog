function tableExists(db, table) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table));
}

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
}

function createTrafficGuardTriggers(db) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS analytics_detail_traffic_insert_guard
    BEFORE INSERT ON access_event_details
    WHEN NEW.traffic_kind <> (SELECT traffic_kind FROM access_metrics WHERE id = NEW.metric_id)
      OR (NEW.traffic_kind = 'human' AND NEW.bot_name IS NOT NULL)
      OR (NEW.traffic_kind = 'bot' AND NULLIF(TRIM(NEW.bot_name), '') IS NULL)
    BEGIN
      SELECT RAISE(ABORT, 'traffic classification mismatch');
    END;

    CREATE TRIGGER IF NOT EXISTS analytics_detail_traffic_update_guard
    BEFORE UPDATE OF metric_id, traffic_kind, bot_name ON access_event_details
    WHEN NEW.traffic_kind <> (SELECT traffic_kind FROM access_metrics WHERE id = NEW.metric_id)
      OR (NEW.traffic_kind = 'human' AND NEW.bot_name IS NOT NULL)
      OR (NEW.traffic_kind = 'bot' AND NULLIF(TRIM(NEW.bot_name), '') IS NULL)
    BEGIN
      SELECT RAISE(ABORT, 'traffic classification mismatch');
    END;

    CREATE TRIGGER IF NOT EXISTS analytics_metric_traffic_update_guard
    BEFORE UPDATE OF traffic_kind ON access_metrics
    WHEN EXISTS (
      SELECT 1 FROM access_event_details
      WHERE metric_id = OLD.id AND traffic_kind <> NEW.traffic_kind
    )
    BEGIN
      SELECT RAISE(ABORT, 'traffic classification mismatch');
    END;
  `);
}

function migrateAnalyticsTrafficSchema(db) {
  if (tableExists(db, 'access_metrics')) {
    const metricColumns = columnNames(db, 'access_metrics');
    if (!metricColumns.has('traffic_kind')) {
      db.exec("ALTER TABLE access_metrics ADD COLUMN traffic_kind TEXT NOT NULL DEFAULT 'human' CHECK (traffic_kind IN ('human', 'bot'))");
    }
    db.exec(`
      UPDATE access_metrics SET traffic_kind = 'human'
      WHERE traffic_kind IS NULL OR traffic_kind NOT IN ('human', 'bot');
      CREATE INDEX IF NOT EXISTS idx_access_metrics_traffic_bucket
        ON access_metrics(traffic_kind, bucket_utc);
    `);
  }

  if (tableExists(db, 'access_event_details')) {
    const detailColumns = columnNames(db, 'access_event_details');
    if (!detailColumns.has('traffic_kind')) {
      db.exec("ALTER TABLE access_event_details ADD COLUMN traffic_kind TEXT NOT NULL DEFAULT 'human' CHECK (traffic_kind IN ('human', 'bot'))");
    }
    if (!detailColumns.has('bot_name')) {
      db.exec('ALTER TABLE access_event_details ADD COLUMN bot_name TEXT');
    }
    db.exec(`
      UPDATE access_event_details SET traffic_kind = 'human', bot_name = NULL
      WHERE traffic_kind IS NULL OR traffic_kind NOT IN ('human', 'bot');
      CREATE INDEX IF NOT EXISTS idx_event_details_traffic_observed
        ON access_event_details(traffic_kind, observed_at_utc DESC, metric_id DESC);
      CREATE INDEX IF NOT EXISTS idx_event_details_traffic_ip_observed
        ON access_event_details(traffic_kind, observed_at_utc, ip_address);
    `);
  }

  if (tableExists(db, 'access_metrics') && tableExists(db, 'access_event_details')) {
    createTrafficGuardTriggers(db);
  }
}

module.exports = { migrateAnalyticsTrafficSchema };
