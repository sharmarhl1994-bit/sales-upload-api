-- ============================================================
-- Festival calendar table — monthly Hindu & English festivals
-- with retail impact scores (1=low, 10=highest sales impact)
-- Run once in pgAdmin to create + seed all 4 years of data
-- ============================================================

CREATE TABLE IF NOT EXISTS festivals (
    id            SERIAL      PRIMARY KEY,
    year          INTEGER     NOT NULL,
    fiscal_month  VARCHAR(3)  NOT NULL CHECK (fiscal_month IN ('apr','may','jun','jul','aug','sep','oct','nov','dec','jan','feb','mar')),
    festival_name VARCHAR(100) NOT NULL,
    festival_type VARCHAR(10)  NOT NULL CHECK (festival_type IN ('hindu','islamic','national','western')),
    impact_score  SMALLINT    NOT NULL CHECK (impact_score BETWEEN 1 AND 10),
    UNIQUE (year, festival_name)
);

CREATE INDEX IF NOT EXISTS idx_festivals_year_month ON festivals (year, fiscal_month);

-- ============================================================
-- SEED DATA — 2024 to 2027
-- impact_score guide:
--   10 = Diwali, 9 = Dhanteras, 7 = Navratri/Dussehra
--    6 = Holi / Raksha Bandhan / Christmas
--    5 = Janmashtami / Ganesh Chaturthi / Eid
--    4 = Onam / Valentine's / Mother's Day
--    3 = Baisakhi / Republic Day / Independence Day / Ram Navami
--    2 = Makar Sankranti / Women's Day / Father's Day
-- ============================================================

INSERT INTO festivals (year, fiscal_month, festival_name, festival_type, impact_score) VALUES

-- ── 2024 ──────────────────────────────────────────────────────
(2024,'jan','Makar Sankranti 2024',    'hindu',    2),
(2024,'jan','Republic Day 2024',       'national', 3),
(2024,'feb','Valentine Day 2024',      'western',  4),
(2024,'mar','Women Day 2024',          'western',  2),
(2024,'mar','Holi 2024',               'hindu',    6),
(2024,'apr','Gudi Padwa 2024',         'hindu',    3),
(2024,'apr','Eid ul-Fitr 2024',        'islamic',  5),
(2024,'apr','Baisakhi 2024',           'hindu',    3),
(2024,'apr','Ram Navami 2024',         'hindu',    3),
(2024,'may','Mother Day 2024',         'western',  4),
(2024,'jun','Eid ul-Adha 2024',        'islamic',  5),
(2024,'jun','Father Day 2024',         'western',  2),
(2024,'jul','Rath Yatra 2024',         'hindu',    3),
(2024,'aug','Independence Day 2024',   'national', 3),
(2024,'aug','Raksha Bandhan 2024',     'hindu',    6),
(2024,'aug','Janmashtami 2024',        'hindu',    5),
(2024,'sep','Onam 2024',               'hindu',    4),
(2024,'sep','Ganesh Chaturthi 2024',   'hindu',    5),
(2024,'oct','Navratri 2024',           'hindu',    7),
(2024,'oct','Dussehra 2024',           'hindu',    7),
(2024,'oct','Karva Chauth 2024',       'hindu',    5),
(2024,'oct','Dhanteras 2024',          'hindu',    9),
(2024,'nov','Diwali 2024',             'hindu',   10),
(2024,'nov','Guru Nanak Jayanti 2024', 'hindu',    3),
(2024,'dec','Christmas 2024',          'western',  6),
(2024,'dec','New Year Eve 2024',       'western',  5),

-- ── 2025 ──────────────────────────────────────────────────────
(2025,'jan','Makar Sankranti 2025',    'hindu',    2),
(2025,'jan','Republic Day 2025',       'national', 3),
(2025,'feb','Valentine Day 2025',      'western',  4),
(2025,'mar','Eid ul-Fitr 2025',        'islamic',  5),
(2025,'mar','Women Day 2025',          'western',  2),
(2025,'mar','Holi 2025',               'hindu',    6),
(2025,'mar','Gudi Padwa 2025',         'hindu',    3),
(2025,'apr','Ram Navami 2025',         'hindu',    3),
(2025,'apr','Baisakhi 2025',           'hindu',    3),
(2025,'may','Mother Day 2025',         'western',  4),
(2025,'jun','Eid ul-Adha 2025',        'islamic',  5),
(2025,'jun','Father Day 2025',         'western',  2),
(2025,'aug','Independence Day 2025',   'national', 3),
(2025,'aug','Raksha Bandhan 2025',     'hindu',    6),
(2025,'aug','Janmashtami 2025',        'hindu',    5),
(2025,'aug','Ganesh Chaturthi 2025',   'hindu',    5),
(2025,'sep','Onam 2025',               'hindu',    4),
(2025,'sep','Navratri 2025',           'hindu',    7),
(2025,'oct','Dussehra 2025',           'hindu',    7),
(2025,'oct','Karva Chauth 2025',       'hindu',    5),
(2025,'oct','Dhanteras 2025',          'hindu',    9),
(2025,'oct','Diwali 2025',             'hindu',   10),
(2025,'nov','Guru Nanak Jayanti 2025', 'hindu',    3),
(2025,'dec','Christmas 2025',          'western',  6),
(2025,'dec','New Year Eve 2025',       'western',  5),

-- ── 2026 ──────────────────────────────────────────────────────
-- KEY SHIFT: Diwali + Dhanteras move to NOVEMBER in 2026
(2026,'jan','Makar Sankranti 2026',    'hindu',    2),
(2026,'jan','Republic Day 2026',       'national', 3),
(2026,'feb','Valentine Day 2026',      'western',  4),
(2026,'mar','Eid ul-Fitr 2026',        'islamic',  5),
(2026,'mar','Women Day 2026',          'western',  2),
(2026,'mar','Holi 2026',               'hindu',    6),
(2026,'mar','Gudi Padwa 2026',         'hindu',    3),
(2026,'apr','Baisakhi 2026',           'hindu',    3),
(2026,'apr','Ram Navami 2026',         'hindu',    3),
(2026,'may','Eid ul-Adha 2026',        'islamic',  5),
(2026,'may','Mother Day 2026',         'western',  4),
(2026,'jun','Father Day 2026',         'western',  2),
(2026,'aug','Independence Day 2026',   'national', 3),
(2026,'aug','Janmashtami 2026',        'hindu',    5),
(2026,'aug','Raksha Bandhan 2026',     'hindu',    6),
(2026,'sep','Onam 2026',               'hindu',    4),
(2026,'sep','Ganesh Chaturthi 2026',   'hindu',    5),
(2026,'oct','Navratri 2026',           'hindu',    7),
(2026,'oct','Dussehra 2026',           'hindu',    7),
(2026,'oct','Karva Chauth 2026',       'hindu',    5),
(2026,'nov','Dhanteras 2026',          'hindu',    9),   -- shifted from Oct!
(2026,'nov','Diwali 2026',             'hindu',   10),   -- shifted from Oct!
(2026,'nov','Guru Nanak Jayanti 2026', 'hindu',    3),
(2026,'dec','Christmas 2026',          'western',  6),
(2026,'dec','New Year Eve 2026',       'western',  5),

-- ── 2027 ──────────────────────────────────────────────────────
(2027,'jan','Makar Sankranti 2027',    'hindu',    2),
(2027,'jan','Republic Day 2027',       'national', 3),
(2027,'feb','Valentine Day 2027',      'western',  4),
(2027,'mar','Eid ul-Fitr 2027',        'islamic',  5),
(2027,'mar','Women Day 2027',          'western',  2),
(2027,'mar','Holi 2027',               'hindu',    6),
(2027,'apr','Gudi Padwa 2027',         'hindu',    3),
(2027,'apr','Baisakhi 2027',           'hindu',    3),
(2027,'apr','Ram Navami 2027',         'hindu',    3),
(2027,'may','Eid ul-Adha 2027',        'islamic',  5),
(2027,'may','Mother Day 2027',         'western',  4),
(2027,'jun','Father Day 2027',         'western',  2),
(2027,'aug','Independence Day 2027',   'national', 3),
(2027,'aug','Raksha Bandhan 2027',     'hindu',    6),
(2027,'aug','Janmashtami 2027',        'hindu',    5),
(2027,'sep','Onam 2027',               'hindu',    4),
(2027,'sep','Ganesh Chaturthi 2027',   'hindu',    5),
(2027,'sep','Navratri 2027',           'hindu',    7),
(2027,'oct','Dussehra 2027',           'hindu',    7),
(2027,'oct','Karva Chauth 2027',       'hindu',    5),
(2027,'oct','Dhanteras 2027',          'hindu',    9),
(2027,'oct','Diwali 2027',             'hindu',   10),
(2027,'nov','Guru Nanak Jayanti 2027', 'hindu',    3),
(2027,'dec','Christmas 2027',          'western',  6),
(2027,'dec','New Year Eve 2027',       'western',  5)

ON CONFLICT (year, festival_name) DO NOTHING;
