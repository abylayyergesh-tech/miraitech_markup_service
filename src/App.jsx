import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import Plotly from 'plotly.js-dist-min'
import { parquetReadObjects } from 'hyparquet'
import './App.css'

// ── Constants ──────────────────────────────────────────────────────────────
const API_BASE = import.meta.env.VITE_API_BASE ?? 'https://dev-api.miraitech.health'

// Math.max/min(...array) blows the call stack on long sessions (V8 caps spread
// argument count well below typical sample counts) — reduce instead.
function arrayMax(arr) {
  let m = -Infinity
  for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i]
  return m
}
function arrayMin(arr) {
  let m = Infinity
  for (let i = 0; i < arr.length; i++) if (arr[i] < m) m = arr[i]
  return m
}

function parseApiError(errData, status) {
  const detail = errData?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) return detail.map(d => d.msg || String(d)).join('; ')
  if (detail && typeof detail === 'object') return detail.message || JSON.stringify(detail)
  return `Ошибка ${status}`
}

const PALETTE = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728',
  '#9467bd', '#8c564b', '#e377c2', '#17becf',
]
const NON_DATA_COLS = new Set([
  'Name', 'Time', 'time', 'timestamp', 'Timestamp', 't',
  'target', 'Target', 'label', 'Label',
])
const PREFERRED_COLS = ['AcX', 'AcY', 'AcZ', 'XData', 'YData', 'ZData', 'GravityZ']
const SPEED_TRACKER = 'ESP32_SpeedTracker'
const ST_COLOR = '#2ca02c'
const ST_COL_NAMES = ['Distance', 'Speed', 'DistanceM', 'VelocityMs']
const ST_ONLY_COLS = new Set(ST_COL_NAMES)
// Distinct colours per SpeedTracker column so Distance and Speed don't look alike.
const ST_COL_COLORS = {
  Speed: '#2ca02c',       // green — keeps the SpeedTracker brand colour
  VelocityMs: '#2ca02c',
  Distance: '#9467bd',    // purple
  DistanceM: '#9467bd',
}
// Speed/Distance-predict overlays (charts/sprint-speed): drawn on top of their
// respective subplots. Both read from the same fetched series.
const SPEED_PRED_COLS = new Set(['Speed', 'VelocityMs'])
const DISTANCE_PRED_COLS = new Set(['Distance', 'DistanceM'])
const PRED_COLOR = '#d62728'
const EXTRA_CALCULATORS = [
  {
    id: 'step-detector-ttest',
    label: 'Step Detector T-Test',
    description: 'Контакты по давлению Sensor 1 + Sensor 2',
    color: '#7c3aed',
    fill: 'rgba(124,58,237,0.10)',
  },
  {
    id: 'tkeo-cadence',
    label: 'TKEO Cadence',
    description: 'Каденс и контакты по TKEO акселерометра',
    color: '#0891b2',
    fill: 'rgba(8,145,178,0.10)',
  },
  {
    id: 'step-cadence',
    label: 'Step Cadence',
    description: 'ML-контакты и фактическое время опоры',
    color: '#d97706',
    fill: 'rgba(217,119,6,0.10)',
  },
]
const EXTRA_CALCULATOR_BY_ID = Object.fromEntries(EXTRA_CALCULATORS.map(calc => [calc.id, calc]))

// Insole pressure channels and the device-name → foot mapping used for
// per-foot calibration/normalization (mirrors the backend: ESP32_Sensor_1 is
// the left insole, ESP32_Sensor_2 the right).
const SENSOR_COLS = ['Sensor_1', 'Sensor_2', 'Sensor_3', 'Sensor_4']
const SENSOR_NAME_TO_FOOT = { ESP32_Sensor_1: 'left', ESP32_Sensor_2: 'right' }

function parseSessionRows(raw) {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'string') throw new Error('Некорректные данные сессии')
  try {
    return JSON.parse(raw)
  } catch {
    return JSON.parse(
      raw
        .replace(/\bNaN\b/g, 'null')
        .replace(/\b-?Infinity\b/g, 'null')
    )
  }
}

function rowsToColMap(rows) {
  const colMap = {}
  Object.keys(rows[0]).forEach(k => { colMap[k] = [] })
  rows.forEach(row => Object.entries(row).forEach(([k, v]) => colMap[k].push(v)))
  return colMap
}

function colMapToRows(colMap) {
  const columns = Object.keys(colMap || {})
  if (!columns.length) return []
  const length = Math.max(...columns.map(column => colMap[column]?.length || 0))
  return Array.from({ length }, (_, index) => {
    const row = {}
    columns.forEach(column => { row[column] = colMap[column]?.[index] ?? null })
    return row
  })
}

function detectTimeCol(allCols) {
  return allCols.find(c => c === 'Time')
    || allCols.find(c => ['time', 'timestamp', 'Timestamp', 't'].includes(c))
    || allCols[0]
}

function computeNumericColumns(colMap, tCol) {
  return Object.keys(colMap).filter(c => {
    if (NON_DATA_COLS.has(c) || c === tCol) return false
    return (colMap[c] || []).some(v => safeNum(v) !== null)
  })
}

function sortSensorNames(colMap) {
  if (!colMap['Name']) return []
  return [...new Set(colMap['Name'].filter(v => v != null && v !== ''))]
    .sort((a, b) => a.localeCompare(b))
}

function computeAutoOffsetST(colMap, timeCol, insoleNames) {
  if (!insoleNames.length || !colMap[timeCol] || !colMap['Name']) return 0
  const times = colMap[timeCol]
  const names = colMap['Name']
  let insoleMin = Infinity
  let stMin = Infinity
  for (let i = 0; i < times.length; i++) {
    const t = safeNum(times[i])
    if (t === null) continue
    const n = names[i]
    if (n === SPEED_TRACKER) { if (t < stMin) stMin = t }
    else if (insoleNames.includes(n)) { if (t < insoleMin) insoleMin = t }
  }
  if (!isFinite(insoleMin) || !isFinite(stMin)) return 0
  return insoleMin - stMin
}

function resolveStDataCol(data, col) {
  if ((data[col] || []).some(v => safeNum(v) !== null)) return col
  const alt = { Distance: 'DistanceM', Speed: 'VelocityMs', DistanceM: 'Distance', VelocityMs: 'Speed' }[col]
  if (alt && (data[alt] || []).some(v => safeNum(v) !== null)) return alt
  return col
}

function buildDefaultCols(numCols, hasSpeedTracker) {
  const imu = PREFERRED_COLS.filter(c => numCols.includes(c)).slice(0, 3)
  const st  = hasSpeedTracker ? ST_COL_NAMES.filter(c => numCols.includes(c)) : []
  const merged = [...imu]
  st.forEach(c => { if (!merged.includes(c)) merged.push(c) })
  return merged.length ? merged : numCols.slice(0, 3)
}

// Derived channel: TKEO of the accel magnitude, mirroring the backend
// (ml_speed_calculator._foot_features / build_session_parquets._tkeo):
// psi[i] = x[i]² − x[i−1]·x[i+1], centered rolling mean over
// max(3, round(0.03 s · fs)) samples, clamped to ≥ 0 after smoothing.
// Computed per sensor (rows are interleaved across sensors) in time order.
function addAccTkeoColumn(colMap, tCol) {
  if (colMap['acc_tkeo']) return // parquet already carries it
  const { AcX, AcY, AcZ } = colMap
  const times = colMap[tCol]
  const names = colMap['Name']
  if (!AcX || !AcY || !AcZ || !times) return

  const n = times.length
  const out = new Array(n).fill(null)
  const sensors = names
    ? [...new Set(names.filter(v => v != null && v !== ''))]
    : [null]

  sensors.forEach(sensor => {
    const idx = []
    for (let i = 0; i < n; i++) {
      if (sensor !== null && names[i] !== sensor) continue
      if (safeNum(times[i]) === null) continue
      if (safeNum(AcX[i]) === null || safeNum(AcY[i]) === null || safeNum(AcZ[i]) === null) continue
      idx.push(i)
    }
    if (idx.length < 3) return
    idx.sort((a, b) => safeNum(times[a]) - safeNum(times[b]))

    const t   = idx.map(i => safeNum(times[i]))
    const mag = idx.map(i => Math.hypot(safeNum(AcX[i]), safeNum(AcY[i]), safeNum(AcZ[i])))

    // Sample rate from the median dt; Time can be ms or s (~500 Hz either way).
    const dts = []
    for (let k = 1; k < t.length; k++) { const d = t[k] - t[k - 1]; if (d > 0) dts.push(d) }
    if (!dts.length) return
    dts.sort((a, b) => a - b)
    let dt = dts[Math.floor(dts.length / 2)]
    if (dt > 0.5) dt /= 1000 // ms → s
    const fs = 1 / dt

    const m = mag.length
    const psi = new Array(m).fill(0)
    for (let k = 1; k < m - 1; k++) psi[k] = mag[k] * mag[k] - mag[k - 1] * mag[k + 1]

    // pandas rolling(win, center=True, min_periods=1): [k−⌊win/2⌋, k+⌊(win−1)/2⌋]
    const win  = Math.max(3, Math.round(0.03 * fs))
    const back = Math.floor(win / 2)
    const fwd  = Math.floor((win - 1) / 2)
    const cum = new Array(m + 1)
    cum[0] = 0
    for (let k = 0; k < m; k++) cum[k + 1] = cum[k] + psi[k]
    for (let k = 0; k < m; k++) {
      const lo = Math.max(0, k - back)
      const hi = Math.min(m - 1, k + fwd)
      out[idx[k]] = Math.max((cum[hi + 1] - cum[lo]) / (hi - lo + 1), 0)
    }
  })

  colMap['acc_tkeo'] = out
}

// A stored additional_info blob can arrive JSON-encoded one or more levels deep
// (the backend double/triple-encodes it). Peel string layers until we reach a
// real value or give up.
function deepUnwrapJson(value, maxDepth = 4) {
  let v = value
  for (let i = 0; i < maxDepth && typeof v === 'string'; i++) {
    try { v = JSON.parse(v) } catch { break }
  }
  return v
}

// A calibration bound must be exactly four finite numbers (booleans excluded —
// typeof true !== 'number').
function isCalibQuad(a) {
  return Array.isArray(a) && a.length === 4
    && a.every(x => typeof x === 'number' && isFinite(x))
}

// Pull { left, right } insole calibration out of a session's additional_info,
// mirroring the backend shape
// additional_info.intake_data.insole_calibration.{left,right}.{min,max}.
// Returns null when it's absent or invalid, so callers fall back to the raw
// Sensor_* values untouched.
function extractInsoleCalibration(additionalInfo) {
  const info = deepUnwrapJson(additionalInfo)
  if (!info || typeof info !== 'object') return null
  const intake = deepUnwrapJson(info.intake_data)
  if (!intake || typeof intake !== 'object') return null
  const calib = deepUnwrapJson(intake.insole_calibration)
  if (!calib || typeof calib !== 'object') return null

  const parseFoot = (footRaw) => {
    const foot = deepUnwrapJson(footRaw)
    if (!foot || typeof foot !== 'object') return null
    const min = deepUnwrapJson(foot.min)
    const max = deepUnwrapJson(foot.max)
    return isCalibQuad(min) && isCalibQuad(max) ? { min, max } : null
  }

  const left = parseFoot(calib.left)
  const right = parseFoot(calib.right)
  if (!left && !right) return null
  return { left, right }
}

// Per-timestep min-max normalization of one sensor reading. Values outside the
// calibration's [min, max] are left unclamped (can go <0 or >1).
// Degenerate calibration (max <= min) contributes nothing (0).
function normalizeSensorValue(value, mn, mx) {
  const range = mx - mn
  if (range <= 0) return 0.0
  return (value - mn) / range
}

// Derived channels: Sensor_1..4_Normalized in [0, 1]. Each row is normalized
// with its own foot's calibration (ESP32_Sensor_1 → left, ESP32_Sensor_2 →
// right), mirroring the backend insole_normalization but WITHOUT the
// session-level aggregation to percentages — these stay raw per-timestep
// normalized values so they can be plotted over time. Returns the list of
// columns added (empty when the session carries no valid calibration, in which
// case consumers keep using the raw Sensor_* columns).
function addNormalizedSensorColumns(colMap, additionalInfo) {
  const calib = extractInsoleCalibration(additionalInfo)
  if (!calib) return []
  const names = colMap['Name']
  const added = []

  SENSOR_COLS.forEach((col, si) => {
    const raw = colMap[col]
    if (!raw) return
    const normCol = `${col}_Normalized`
    if (colMap[normCol]) { added.push(normCol); return }

    const out = new Array(raw.length).fill(null)
    for (let i = 0; i < raw.length; i++) {
      const v = safeNum(raw[i])
      if (v === null) continue
      const foot = names ? SENSOR_NAME_TO_FOOT[names[i]] : null
      const footCalib = foot ? calib[foot] : null
      if (!footCalib) continue // this foot lacks calibration → leave as no-data
      out[i] = normalizeSensorValue(v, footCalib.min[si], footCalib.max[si])
    }
    colMap[normCol] = out
    added.push(normCol)
  })

  return added
}

const L_FILL = 'rgba(31,119,180,0.35)'
const R_FILL = 'rgba(255,127,14,0.35)'
const L_LINE = 'rgba(31,119,180,0.9)'
const R_LINE = 'rgba(255,127,14,0.9)'
const GAP_FILL = 'rgba(220,53,69,0.35)'
const GAP_LINE = 'rgba(220,53,69,0.92)'
const SEL_FILL = 'rgba(234,179,8,0.5)'
const SEL_LINE = '#ca8a04'

function buildGapBandShapes(intervals, nSubplots) {
  if (!intervals.length || nSubplots < 1) return []
  const shapes = []
  for (const [x0, x1] of intervals) {
    for (let i = 0; i < nSubplots; i++) {
      shapes.push({
        type: 'rect',
        x0, x1,
        xref: 'x',
        y0: 0, y1: 1,
        yref: i === 0 ? 'y domain' : `y${i + 1} domain`,
        fillcolor: GAP_FILL,
        line: { color: GAP_LINE, width: 1.5 },
        layer: 'below',
      })
    }
  }
  return shapes
}

function safeNum(v) {
  if (v === null || v === undefined) return null
  const n = typeof v === 'bigint' ? Number(v) : Number(v)
  return isFinite(n) ? n : null
}

function unwrapAngleDegrees(arr, threshold = 180.0) {
  if (!arr || arr.length === 0) return arr
  const result = new Array(arr.length)
  result[0] = arr[0]
  let offset = 0
  for (let i = 1; i < arr.length; i++) {
    const curr = safeNum(arr[i])
    const prev = safeNum(arr[i - 1])
    if (curr === null || prev === null) { result[i] = arr[i]; continue }
    const diff = curr - prev
    if (diff > threshold) offset -= 360
    else if (diff < -threshold) offset += 360
    result[i] = arr[i] + offset
  }
  return result
}
function formatTime(s) {
  if (!isFinite(s) || s < 0) return '0:00.0'
  const m = Math.floor(s / 60)
  const sec = (s % 60).toFixed(1).padStart(4, '0')
  return `${m}:${sec}`
}
function formatDuration(d, unit) {
  if (!isFinite(d) || d < 0) return '—'
  if (unit === 'ms') {
    if (d >= 1000) return (d / 1000).toFixed(2) + 'с'
    return d.toFixed(0) + 'мс'
  }
  return d.toFixed(3) + 'с'
}

function buildCursorShapes(x, n) {
  return Array.from({ length: n }, (_, i) => ({
    type: 'line',
    x0: x, x1: x,
    y0: 0, y1: 1,
    xref: 'x',
    yref: i === 0 ? 'y domain' : `y${i + 1} domain`,
    line: { color: 'rgba(220,40,40,0.85)', width: 2, dash: 'dot' },
  }))
}

function buildSelectedPointShapes(x, n) {
  return Array.from({ length: n }, (_, i) => ({
    type: 'line',
    x0: x, x1: x,
    y0: 0, y1: 1,
    xref: 'x',
    yref: i === 0 ? 'y domain' : `y${i + 1} domain`,
    line: { color: SEL_LINE, width: 3.5 },
    layer: 'above',
  }))
}

function getPairStartIndex(index) {
  return index - (index % 2)
}

function parseCsvRow(line) {
  const out = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ }
        else inQuotes = false
      } else cur += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

function parseCsvText(text) {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/)
  if (!lines.length) throw new Error('CSV пустой')
  const headers = parseCsvRow(lines[0]).map(h => h.trim())
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    const vals = parseCsvRow(lines[i])
    const row = {}
    headers.forEach((h, j) => { row[h] = vals[j] ?? '' })
    rows.push(row)
  }
  return { headers, rows }
}

function isTargetOne(v) {
  if (v === 1 || v === '1' || v === 1.0) return true
  const s = String(v ?? '').trim()
  return s === '1' || s === '1.0'
}

function extractContactPairsFromTargetRuns(times, targets, offset = 0) {
  const contacts = []
  let i = 0
  while (i < targets.length) {
    while (i < targets.length && !isTargetOne(targets[i])) i++
    if (i >= targets.length) break
    const startT = safeNum(times[i])
    if (startT === null) { i++; continue }
    let endT = startT
    while (i < targets.length && isTargetOne(targets[i])) {
      const t = safeNum(times[i])
      if (t !== null) endT = t
      i++
    }
    contacts.push(startT + offset, endT + offset)
  }
  return contacts
}

function extractContactsFromLabeledCsv(rows, timeCol, leftSensor, rightSensor, offsetS1, offsetS2) {
  const bySensor = (sensorName) => {
    const filtered = rows
      .filter(r => (r.Name || r.name) === sensorName)
      .map(r => ({
        t: safeNum(r[timeCol]),
        target: r.Target ?? r.target ?? r.Label ?? r.label ?? '',
      }))
      .filter(r => r.t !== null)
      .sort((a, b) => a.t - b.t)
    return filtered
  }

  const leftRows = bySensor(leftSensor)
  const rightRows = bySensor(rightSensor)
  if (!leftRows.length && !rightRows.length) {
    throw new Error(`Строки для сенсоров ${leftSensor} / ${rightSensor} не найдены`)
  }

  const leftContacts = extractContactPairsFromTargetRuns(
    leftRows.map(r => r.t),
    leftRows.map(r => r.target),
    offsetS1,
  )
  const rightContacts = extractContactPairsFromTargetRuns(
    rightRows.map(r => r.t),
    rightRows.map(r => r.target),
    offsetS2,
  )

  return { leftContacts, rightContacts, leftCount: leftContacts.length / 2, rightCount: rightContacts.length / 2 }
}

// ── Main App ───────────────────────────────────────────────────────────────
export default function App() {
  // Auth
  const [token, setToken]               = useState(() => sessionStorage.getItem('auth_token') || '')
  const [loginEmail, setLoginEmail]     = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginError, setLoginError]     = useState('')
  const [authLoading, setAuthLoading]   = useState(false)

  // Session
  const [sessionId, setSessionId]       = useState('')
  const [sessionLabel, setSessionLabel] = useState('')
  const [markupFiles, setMarkupFiles]   = useState([])
  const [activeMarkupFileId, setActiveMarkupFileId] = useState('')
  const [sessionAdditionalInfo, setSessionAdditionalInfo] = useState(null)
  const [isSaving, setIsSaveLoading]    = useState(false)
  const [pendingImportFilename, setPendingImportFilename] = useState('')

  // Sessions list (for autocomplete)
  const [sessionsList, setSessionsList]               = useState([])
  const [sessionsListLoading, setSessionsListLoading] = useState(false)
  const [showSessionDropdown, setShowSessionDropdown] = useState(false)
  const sessionInputRef = useRef(null)
  const dropdownRef     = useRef(null)

  // Files
  const [videoUrl, setVideoUrl]         = useState(null)
  const [videoName, setVideoName]       = useState('')

  // Data
  const [parquetData, setParquetData]   = useState(null)
  const [columns, setColumns]           = useState([])
  const [sensorNames, setSensorNames]   = useState([])
  const [showSensor1, setShowSensor1]   = useState(true)
  const [showSensor2, setShowSensor2]   = useState(true)
  const [showSpeedTracker, setShowSpeedTracker] = useState(false)
  const [speedPredict, setSpeedPredict] = useState(null)
  const [predictLoading, setPredictLoading] = useState(false)
  const [showSpeedPredict, setShowSpeedPredict] = useState(false)
  const [showDistancePredict, setShowDistancePredict] = useState(false)
  const [extraCalculatorsOpen, setExtraCalculatorsOpen] = useState(false)
  const [calculatorResults, setCalculatorResults] = useState({})
  const [activeCalculators, setActiveCalculators] = useState([])
  const [calculatorLoading, setCalculatorLoading] = useState('')
  const [checkHzData, setCheckHzData]   = useState(null)
  const [selectedCols, setSelectedCols] = useState([])
  const [timeCol, setTimeCol]           = useState('Time')
  const [offsetS1, setOffsetS1]         = useState(0)
  const [offsetS2, setOffsetS2]         = useState(0)
  const [offsetST, setOffsetST]         = useState(0)
  const [timeUnit, setTimeUnit]         = useState('ms')

  // Video state
  const [videoDuration, setVideoDuration] = useState(0)
  const [currentTime, setCurrentTime]     = useState(0)

  // Video zoom/pan
  const [zoom, setZoom]   = useState(1)
  const [panX, setPanX]   = useState(0)
  const [panY, setPanY]   = useState(0)

  // UI
  const [status, setStatus]         = useState({ text: '', type: 'idle' })
  const [chartReady, setChartReady] = useState(false)
  const [dragOver, setDragOver]     = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [dataPanelOpen, setDataPanelOpen]       = useState(true)
  const [chartPanelOpen, setChartPanelOpen]     = useState(true)
  const [labMenuOpen, setLabMenuOpen]           = useState(false)
  const labMenuRef = useRef(null)

  // Labeling
  const [labelingMode, setLabelingMode]           = useState(false)
  const [currentFoot, setCurrentFoot]             = useState('left')
  const [leftContacts, setLeftContacts]           = useState([])
  const [rightContacts, setRightContacts]         = useState([])
  const [showLeftPatterns, setShowLeftPatterns]   = useState(true)
  const [showRightPatterns, setShowRightPatterns] = useState(true)
  const [showGaps, setShowGaps]                   = useState(false)
  const [selectedMarkup, setSelectedMarkup]       = useState(null)
  const [anglesUnwrapped, setAnglesUnwrapped]     = useState(false)
  const [relabelStep, setRelabelStep]             = useState(null)

  // Refs
  const videoRef        = useRef(null)
  const videoWrapRef    = useRef(null)
  const chartDivRef     = useRef(null)
  const timelineRef     = useRef(null)
  const videoUrlRef     = useRef(null)
  const offsetS1Ref     = useRef(0)
  const offsetS2Ref     = useRef(0)
  const offsetSTRef     = useRef(0)
  const showSpeedTrackerRef = useRef(false)
  const timeUnitRef     = useRef('ms')
  const lastTRef        = useRef(null)
  const plotInitRef      = useRef(false)
  const contactShapesRef = useRef([])
  const gapShapesRef     = useRef([])
  const calculatorShapesRef = useRef([])
  const calculatorResultsRef = useRef({})
  const activeCalculatorsRef = useRef([])
  const calculatorDataVersionRef = useRef(0)
  const cursorShapesRef  = useRef([])
  const selectedColsRef  = useRef([])
  const anglesUnwrappedRef = useRef(false)
  const isDragging       = useRef(false)
  const isVideoPan      = useRef(false)
  const vidLblRef       = useRef(null)
  const imuLblRef       = useRef(null)
  const labelingRef      = useRef(false)
  const currentFootRef   = useRef('left')
  const leftContactsRef  = useRef([])
  const rightContactsRef = useRef([])
  const showLeftRef      = useRef(true)
  const showRightRef     = useRef(true)
  const showGapsRef      = useRef(false)
  const s1TraceIdxRef    = useRef([])
  const s2TraceIdxRef    = useRef([])
  const stTraceIdxRef    = useRef([])
  const selectedMarkupRef = useRef(null)
  const relabelStepRef   = useRef(null)
  const zoomRangeRef     = useRef(null)
  const importedCsvTextRef = useRef('')
  const skipClearImportCsvRef = useRef(false)

  const insoleSensorNames = useMemo(
    () => sensorNames.filter(n => n !== SPEED_TRACKER),
    [sensorNames],
  )
  const hasSpeedTracker = useMemo(
    () => sensorNames.includes(SPEED_TRACKER),
    [sensorNames],
  )

  useEffect(() => { offsetS1Ref.current    = offsetS1     }, [offsetS1])
  useEffect(() => { offsetS2Ref.current    = offsetS2     }, [offsetS2])
  useEffect(() => { offsetSTRef.current    = offsetST     }, [offsetST])
  useEffect(() => { showSpeedTrackerRef.current = showSpeedTracker }, [showSpeedTracker])
  useEffect(() => { timeUnitRef.current    = timeUnit     }, [timeUnit])
  useEffect(() => { labelingRef.current    = labelingMode }, [labelingMode])
  useEffect(() => { currentFootRef.current = currentFoot  }, [currentFoot])
  useEffect(() => { selectedColsRef.current = selectedCols }, [selectedCols])
  useEffect(() => { showGapsRef.current = showGaps }, [showGaps])
  useEffect(() => { anglesUnwrappedRef.current = anglesUnwrapped }, [anglesUnwrapped])
  useEffect(() => { selectedMarkupRef.current = selectedMarkup }, [selectedMarkup])
  useEffect(() => { relabelStepRef.current = relabelStep }, [relabelStep])
  useEffect(() => { calculatorResultsRef.current = calculatorResults }, [calculatorResults])
  useEffect(() => { activeCalculatorsRef.current = activeCalculators }, [activeCalculators])

  useEffect(() => {
    if (!selectedMarkup) return
    const contacts = selectedMarkup.foot === 'left' ? leftContacts : rightContacts
    if (selectedMarkup.index >= contacts.length) setSelectedMarkup(null)
  }, [leftContacts, rightContacts, selectedMarkup])

  useEffect(() => {
    if (skipClearImportCsvRef.current) {
      skipClearImportCsvRef.current = false
      return
    }
    if (importedCsvTextRef.current) importedCsvTextRef.current = ''
  }, [leftContacts, rightContacts])

  // ── Auth ──────────────────────────────────────────────────────────────────
  const handleLogin = useCallback(async (e) => {
    e.preventDefault()
    setAuthLoading(true)
    setLoginError('')
    try {
      const resp = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'accept': 'application/json' },
        body: JSON.stringify({ email: loginEmail, password: loginPassword }),
      })
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}))
        throw new Error(parseApiError(errData, resp.status))
      }
      const data = await resp.json()
      const tok = data.access_token || data.token
      if (!tok) throw new Error('Токен не получен от сервера')
      setToken(tok)
      sessionStorage.setItem('auth_token', tok)
    } catch (err) {
      if (err instanceof TypeError) {
        setLoginError('API-сервер недоступен. Запустите backend на порту 8000.')
      } else {
        setLoginError(err.message)
      }
    } finally {
      setAuthLoading(false)
    }
  }, [loginEmail, loginPassword])

  const handleLogout = useCallback(() => {
    setToken('')
    sessionStorage.removeItem('auth_token')
  }, [])

  // ── Sessions list fetch ───────────────────────────────────────────────────
  useEffect(() => {
    if (!token) { setSessionsList([]); return }
    setSessionsListLoading(true)
    fetch(`${API_BASE}/api/sessions?page_size=100`, {
      headers: { 'accept': 'application/json', 'Authorization': `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => setSessionsList(data.items || []))
      .catch(() => setSessionsList([]))
      .finally(() => setSessionsListLoading(false))
  }, [token])

  const filteredSessions = useMemo(() => {
    const q = sessionId.trim().toLowerCase()
    if (!q) return sessionsList.slice(0, 25)
    return sessionsList.filter(s =>
      String(s.id).includes(q) ||
      (s.member_name && s.member_name.toLowerCase().includes(q)) ||
      (s.session_title && s.session_title.toLowerCase().includes(q))
    ).slice(0, 25)
  }, [sessionsList, sessionId])

  // close dropdown on outside click
  useEffect(() => {
    const onDown = (e) => {
      if (
        sessionInputRef.current && !sessionInputRef.current.contains(e.target) &&
        dropdownRef.current && !dropdownRef.current.contains(e.target)
      ) setShowSessionDropdown(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  useEffect(() => {
    if (!labMenuOpen) return
    const onDown = (e) => {
      if (labMenuRef.current && !labMenuRef.current.contains(e.target)) {
        setLabMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [labMenuOpen])

  const fetchSessionMarkupsFromDb = useCallback(async (sid, { restoreLatest = false } = {}) => {
    const resp = await fetch(`${API_BASE}/api/sessions/${sid}`, {
      headers: {
        'accept': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    })
    if (resp.status === 401) {
      setToken('')
      sessionStorage.removeItem('auth_token')
      throw new Error('Сессия авторизации истекла — войдите снова')
    }
    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}))
      throw new Error(parseApiError(errData, resp.status))
    }

    const result = await resp.json()
    setSessionAdditionalInfo(result.additional_info || null)
    const files = result.additional_info?.markup_files || []
    setMarkupFiles(files)

    if (restoreLatest && files.length > 0) {
      const lastFile = files[files.length - 1]
      setActiveMarkupFileId(lastFile.id)
      setLeftContacts(lastFile.leftContacts || [])
      setRightContacts(lastFile.rightContacts || [])
      importedCsvTextRef.current = lastFile.csv || ''
      if (lastFile.meta) {
        if (lastFile.meta.offsetS1 !== undefined) setOffsetS1(lastFile.meta.offsetS1)
        if (lastFile.meta.offsetS2 !== undefined) setOffsetS2(lastFile.meta.offsetS2)
        if (lastFile.meta.offsetST !== undefined) setOffsetST(lastFile.meta.offsetST)
        if (lastFile.meta.timeUnit !== undefined) setTimeUnit(lastFile.meta.timeUnit)
      }
    }

    return result
  }, [token])

  // ── Session loader ────────────────────────────────────────────────────────
  const loadSession = useCallback(async () => {
    const sid = sessionId.trim()
    if (!sid) { setStatus({ text: 'Введите номер сессии', type: 'error' }); return }

    setStatus({ text: `Загружаю сессию ${sid}…`, type: 'loading' })
    setSessionLabel(`Сессия #${sid}`)
    setChartReady(false)
    plotInitRef.current = false
    setLeftContacts([])
    setRightContacts([])
    setMarkupFiles([])
    setActiveMarkupFileId('')
    setSessionAdditionalInfo(null)
    setPendingImportFilename('')
    importedCsvTextRef.current = ''
    zoomRangeRef.current = null
    setRelabelStep(null)
    setShowLeftPatterns(true)
    setShowRightPatterns(true)
    setShowSensor1(true)
    setShowSensor2(true)
    setShowSpeedTracker(false)
    setSpeedPredict(null)
    setShowSpeedPredict(false)
    setShowDistancePredict(false)
    calculatorDataVersionRef.current += 1
    setCalculatorResults({})
    setActiveCalculators([])
    setCalculatorLoading('')
    setExtraCalculatorsOpen(false)
    setOffsetST(0)
    setShowGaps(false)
    setCheckHzData(null)
    setSelectedMarkup(null)
    anglesUnwrappedRef.current = false
    setAnglesUnwrapped(false)

    try {
      const resp = await fetch(`${API_BASE}/api/sessions/${sid}`, {
        headers: {
          'accept': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      })
      if (resp.status === 401) {
        setToken('')
        sessionStorage.removeItem('auth_token')
        throw new Error('Сессия авторизации истекла — войдите снова')
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`)

      const result = await resp.json()
      
      setSessionAdditionalInfo(result.additional_info || null)
      const initialMarkupFiles = result.additional_info?.markup_files || []
      setMarkupFiles(initialMarkupFiles)
      if (initialMarkupFiles.length > 0) {
        const lastFile = initialMarkupFiles[initialMarkupFiles.length - 1]
        setActiveMarkupFileId(lastFile.id)
        setLeftContacts(lastFile.leftContacts || [])
        setRightContacts(lastFile.rightContacts || [])
        importedCsvTextRef.current = lastFile.csv || ''
        if (lastFile.meta) {
          if (lastFile.meta.offsetS1 !== undefined) setOffsetS1(lastFile.meta.offsetS1)
          if (lastFile.meta.offsetS2 !== undefined) setOffsetS2(lastFile.meta.offsetS2)
          if (lastFile.meta.offsetST !== undefined) setOffsetST(lastFile.meta.offsetST)
          if (lastFile.meta.timeUnit !== undefined) setTimeUnit(lastFile.meta.timeUnit)
        }
      }

      const rows = parseSessionRows(result.data)

      if (!rows?.length) { setStatus({ text: 'Сессия пустая', type: 'error' }); return }

      const colMap = rowsToColMap(rows)
      const tCol = detectTimeCol(Object.keys(colMap))
      addAccTkeoColumn(colMap, tCol)
      addNormalizedSensorColumns(colMap, result.additional_info)
      setParquetData(colMap)
      setTimeCol(tCol)

      const names = sortSensorNames(colMap)
      const insole = names.filter(n => n !== SPEED_TRACKER)
      const hasST = names.includes(SPEED_TRACKER)
      setSensorNames(names)

      const numCols = computeNumericColumns(colMap, tCol)
      setColumns(numCols)
      setSelectedCols(buildDefaultCols(numCols, hasST))
      setShowSpeedTracker(hasST)
      setOffsetST(hasST ? computeAutoOffsetST(colMap, tCol, insole) : 0)

      const tVals   = (colMap[tCol] || []).map(safeNum).filter(v => v !== null)
      const tMax    = tVals.length ? arrayMax(tVals) : 0
      const autoUnit = tMax > 3600 ? 'ms' : 's'
      setTimeUnit(autoUnit)
      timeUnitRef.current = autoUnit

      const stHint = hasST ? ' · SpeedTracker' : ''
      setStatus({ text: `✓ ${rows.length} строк · ${numCols.length} колонок · ${autoUnit}${stHint}`, type: 'ok' })

      fetch(`${API_BASE}/api/check_hz/${sid}`, {
        headers: { 'accept': 'application/json', 'Authorization': `Bearer ${token}` },
      })
        .then(r => r.ok ? r.json() : Promise.reject())
        .then(data => setCheckHzData(data))
        .catch(() => setCheckHzData(null))
    } catch (err) {
      setStatus({ text: `Ошибка: ${err.message}`, type: 'error' })
    }
  }, [token, sessionId])

  const totalGaps = useMemo(() => {
    if (!checkHzData) return 0
    return Object.values(checkHzData).reduce((n, s) => n + (s.gaps?.length || 0), 0)
  }, [checkHzData])

  // ── Contact + gap shapes ──────────────────────────────────────────────────
  const updateOverlayShapes = useCallback(() => {
    if (!chartDivRef.current || !plotInitRef.current) return

    const contactShapes = []
    const sm = selectedMarkupRef.current
    const nSubplots = selectedColsRef.current.length || 1

    const pushContactShapes = (contacts, fillColor, lineColor, foot) => {
      const isSelectedFoot = sm?.foot === foot
      for (let i = 0; i + 1 < contacts.length; i += 2) {
        const x0 = Math.min(contacts[i], contacts[i + 1])
        const x1 = Math.max(contacts[i], contacts[i + 1])
        const isSel = isSelectedFoot && (sm.index === i || sm.index === i + 1)
        contactShapes.push({
          type: 'rect', x0, x1,
          y0: 0, y1: 1, yref: 'paper',
          fillcolor: isSel ? SEL_FILL : fillColor,
          line: { color: isSel ? SEL_LINE : lineColor, width: isSel ? 3 : 1.5 },
          layer: 'below',
        })
      }
      if (contacts.length % 2 === 1) {
        const i = contacts.length - 1
        const t = contacts[i]
        const isSel = isSelectedFoot && sm.index === i
        contactShapes.push({
          type: 'line', x0: t, x1: t,
          y0: 0, y1: 1, yref: 'paper',
          line: {
            color: isSel ? SEL_LINE : lineColor,
            width: isSel ? 3.5 : 2,
            dash: isSel ? 'solid' : 'dot',
          },
        })
      }
    }

    if (showLeftRef.current)  pushContactShapes(leftContactsRef.current,  L_FILL, L_LINE, 'left')
    if (showRightRef.current) pushContactShapes(rightContactsRef.current, R_FILL, R_LINE, 'right')

    if (sm) {
      const contacts = sm.foot === 'left' ? leftContactsRef.current : rightContactsRef.current
      const t = contacts[sm.index]
      if (t != null) contactShapes.push(...buildSelectedPointShapes(t, nSubplots))
    }
    contactShapesRef.current = contactShapes

    const calculatorShapes = []
    const timeScale = timeUnitRef.current === 'ms' ? 1000 : 1
    activeCalculatorsRef.current.forEach(calculatorId => {
      const style = EXTRA_CALCULATOR_BY_ID[calculatorId]
      const result = calculatorResultsRef.current[calculatorId]
      if (!style || !result?.contacts?.length) return

      result.contacts.forEach(contact => {
        if (contact.foot === 'left' && !showSensor1) return
        if (contact.foot === 'right' && !showSensor2) return
        const shift = contact.foot === 'right' ? offsetS2Ref.current : offsetS1Ref.current
        const x0 = contact.start_time_s * timeScale + shift
        const x1 = contact.end_time_s * timeScale + shift
        if (!isFinite(x0) || !isFinite(x1) || x1 <= x0) return
        calculatorShapes.push({
          type: 'rect', x0, x1,
          y0: 0, y1: 1, yref: 'paper',
          fillcolor: style.fill,
          line: {
            color: style.color,
            width: contact.kind === 'plateau' ? 2 : 1.25,
            dash: contact.foot === 'right' ? 'dot' : 'dash',
          },
          layer: 'below',
        })
      })
    })
    calculatorShapesRef.current = calculatorShapes

    const gapShapes = []
    if (showGapsRef.current && checkHzData) {
      const seen = new Set()
      const intervals = []
      insoleSensorNames.forEach((name, i) => {
        const visible = i === 0 ? showSensor1 : showSensor2
        if (!visible) return
        const gaps = checkHzData[name]?.gaps
        if (!gaps?.length) return
        const shift = i === 0 ? offsetS1Ref.current : offsetS2Ref.current
        for (const [startT, endT] of gaps) {
          const x0 = Math.min(startT, endT) / 1000 + shift
          const x1 = Math.max(startT, endT) / 1000 + shift
          const key = `${x0}|${x1}`
          if (seen.has(key)) continue
          seen.add(key)
          intervals.push([x0, x1])
        }
      })
      const nSubplots = selectedColsRef.current.length || 1
      gapShapes.push(...buildGapBandShapes(intervals, nSubplots))
    }
    gapShapesRef.current = gapShapes

    Plotly.relayout(chartDivRef.current, {
      shapes: [
        ...gapShapesRef.current,
        ...calculatorShapesRef.current,
        ...contactShapesRef.current,
        ...cursorShapesRef.current,
      ],
    })
  }, [showGaps, checkHzData, insoleSensorNames, showSensor1, showSensor2])

  useEffect(() => {
    leftContactsRef.current  = leftContacts
    rightContactsRef.current = rightContacts
    if (plotInitRef.current && chartDivRef.current) updateOverlayShapes()
  }, [leftContacts, rightContacts, updateOverlayShapes])

  useEffect(() => {
    showLeftRef.current  = showLeftPatterns
    showRightRef.current = showRightPatterns
    if (plotInitRef.current && chartDivRef.current) updateOverlayShapes()
  }, [showLeftPatterns, showRightPatterns, updateOverlayShapes])

  useEffect(() => {
    if (plotInitRef.current && chartDivRef.current) updateOverlayShapes()
  }, [showGaps, checkHzData, showSensor1, showSensor2, showSpeedTracker, offsetS1, offsetS2, offsetST, timeUnit, selectedCols, selectedMarkup, calculatorResults, activeCalculators, updateOverlayShapes])

  useEffect(() => {
    if (!chartReady || !chartDivRef.current) return
    if (s1TraceIdxRef.current.length)
      Plotly.restyle(chartDivRef.current, { visible: showSensor1 }, s1TraceIdxRef.current)
    if (s2TraceIdxRef.current.length)
      Plotly.restyle(chartDivRef.current, { visible: showSensor2 }, s2TraceIdxRef.current)
  }, [showSensor1, showSensor2, chartReady])

  const undoContact = useCallback(() => {
    if (currentFootRef.current === 'left') setLeftContacts(p => p.slice(0, -1))
    else setRightContacts(p => p.slice(0, -1))
  }, [])

  const clearCurrentContacts = useCallback(() => {
    if (currentFootRef.current === 'left') setLeftContacts([])
    else setRightContacts([])
  }, [])

  const clearAllContacts = useCallback(() => {
    setLeftContacts([])
    setRightContacts([])
    setSelectedMarkup(null)
  }, [])

  const deleteSelectedMarkup = useCallback(() => {
    if (!selectedMarkup) return
    const { foot, index } = selectedMarkup
    const pairStart = getPairStartIndex(index)
    const removeInterval = (prev) => {
      if (pairStart + 1 < prev.length) {
        return prev.filter((_, i) => i !== pairStart && i !== pairStart + 1)
      }
      if (pairStart < prev.length) {
        return prev.filter((_, i) => i !== pairStart)
      }
      return prev
    }
    if (foot === 'left') setLeftContacts(removeInterval)
    else setRightContacts(removeInterval)
    setSelectedMarkup(null)
  }, [selectedMarkup])

  const generateCsvString = useCallback(() => {
    if (!parquetData) return ''
    const allCols = Object.keys(parquetData)
    const timeArr = parquetData[timeCol] || []
    const nameArr = parquetData['Name']  || []
    const n = timeArr.length
    const rightSensorName = insoleSensorNames[1] || 'ESP32_Sensor_2'

    const buildIv = (contacts, offset) => {
      const out = []
      for (let i = 0; i + 1 < contacts.length; i += 2)
        out.push([
          Math.min(contacts[i], contacts[i + 1]) - offset,
          Math.max(contacts[i], contacts[i + 1]) - offset,
        ])
      return out
    }
    const lIv = buildIv(leftContactsRef.current, offsetS1Ref.current)
    const rIv = buildIv(rightContactsRef.current, offsetS2Ref.current)
    const inIv = (t, ivs) => {
      const tv = safeNum(t); if (tv === null) return false
      return ivs.some(([a, b]) => tv >= a && tv <= b)
    }

    const hdr = [...allCols, 'Target'].join(',')
    const rows = []
    for (let i = 0; i < n; i++) {
      const name = nameArr[i] || ''
      const t    = timeArr[i]
      const target = name === SPEED_TRACKER
        ? ''
        : name === rightSensorName
          ? (inIv(t, rIv) ? 1 : 0)
          : (inIv(t, lIv) ? 1 : 0)
      const vals = allCols.map(c => {
        const v = parquetData[c][i]
        return v == null ? '' : String(v)
      })
      vals.push(String(target))
      rows.push(vals.join(','))
    }

    return hdr + '\n' + rows.join('\n')
  }, [parquetData, timeCol, insoleSensorNames])

  const exportLabels = useCallback(() => {
    const csv = generateCsvString()
    if (!csv) return
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url
    a.download = (sessionLabel || 'session').replace(/\s+/g, '_') + '_labeled.csv'
    document.body.appendChild(a); a.click()
    document.body.removeChild(a); URL.revokeObjectURL(url)
  }, [generateCsvString, sessionLabel])

  const handleSelectMarkupFile = useCallback((id) => {
    setRelabelStep(null)
    setPendingImportFilename('')
    importedCsvTextRef.current = ''
    if (id === 'new' || !id) {
      setActiveMarkupFileId('new')
      setLeftContacts([])
      setRightContacts([])
      return
    }
    const file = markupFiles.find(f => f.id === id)
    if (file) {
      setActiveMarkupFileId(file.id)
      setLeftContacts(file.leftContacts || [])
      setRightContacts(file.rightContacts || [])
      importedCsvTextRef.current = file.csv || ''
      if (file.meta) {
        if (file.meta.offsetS1 !== undefined) setOffsetS1(file.meta.offsetS1)
        if (file.meta.offsetS2 !== undefined) setOffsetS2(file.meta.offsetS2)
        if (file.meta.offsetST !== undefined) setOffsetST(file.meta.offsetST)
        if (file.meta.timeUnit !== undefined) setTimeUnit(file.meta.timeUnit)
      }
    }
  }, [markupFiles])

  const saveMarkupToDb = useCallback(async () => {
    const sid = sessionId.trim()
    if (!sid) {
      setStatus({ text: 'Укажите ID сессии в поле слева', type: 'error' })
      return
    }
    if (leftContactsRef.current.length === 0 && rightContactsRef.current.length === 0) {
      setStatus({ text: 'Нет разметки для сохранения', type: 'error' })
      return
    }

    setIsSaveLoading(true)
    try {
      const currentSession = await fetchSessionMarkupsFromDb(sid)
      const currentAdditionalInfo = currentSession.additional_info || {}
      const existingMarkupFiles = Array.isArray(currentAdditionalInfo.markup_files)
        ? [...currentAdditionalInfo.markup_files]
        : []

      const isNew = !activeMarkupFileId || activeMarkupFileId === 'new'
      const fileId = isNew ? `mf_${Date.now()}` : activeMarkupFileId
      const fileIndex = isNew ? -1 : existingMarkupFiles.findIndex(f => f.id === fileId)

      const csv = (isNew && importedCsvTextRef.current)
        ? importedCsvTextRef.current
        : generateCsvString()
      if (!csv) throw new Error('Не удалось сформировать CSV')

      const defaultFilename = pendingImportFilename
        || `markup_${sid}_v${existingMarkupFiles.length + 1}.csv`

      const newFile = {
        id: fileId,
        filename: !isNew && fileIndex >= 0
          ? existingMarkupFiles[fileIndex].filename
          : defaultFilename,
        type: 'contact_target_csv',
        updated_at: new Date().toISOString(),
        leftContacts: [...leftContactsRef.current],
        rightContacts: [...rightContactsRef.current],
        meta: {
          offsetS1: offsetS1Ref.current,
          offsetS2: offsetS2Ref.current,
          offsetST: offsetSTRef.current,
          timeUnit: timeUnitRef.current,
        },
        csv,
      }

      const updatedFiles = [...existingMarkupFiles]
      if (fileIndex >= 0) {
        updatedFiles[fileIndex] = newFile
      } else {
        updatedFiles.push(newFile)
      }

      const updatedAdditionalInfo = {
        ...currentAdditionalInfo,
        markup_files: updatedFiles,
      }

      const resp = await fetch(`${API_BASE}/api/sessions/${sid}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'accept': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          additional_info: updatedAdditionalInfo,
        }),
      })

      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}))
        throw new Error(parseApiError(errData, resp.status))
      }

      const updatedSession = await resp.json()

      setSessionAdditionalInfo(updatedSession.additional_info || null)
      const nextFiles = updatedSession.additional_info?.markup_files || updatedFiles
      setMarkupFiles(nextFiles)
      setActiveMarkupFileId(fileId)
      setPendingImportFilename('')
      importedCsvTextRef.current = csv

      setStatus({
        text: `✓ Разметка «${newFile.filename}» сохранена в БД (${nextFiles.length} верс.)`,
        type: 'ok',
      })
    } catch (err) {
      setStatus({ text: `Ошибка сохранения: ${err.message}`, type: 'error' })
    } finally {
      setIsSaveLoading(false)
    }
  }, [
    sessionId,
    activeMarkupFileId,
    generateCsvString,
    token,
    pendingImportFilename,
    fetchSessionMarkupsFromDb,
  ])

  const importLabeledCsv = useCallback(async (file) => {
    if (!parquetData) {
      setStatus({ text: 'Сначала загрузите сессию или parquet', type: 'error' })
      return
    }

    const sid = sessionId.trim()
    if (!sid) {
      setStatus({ text: 'Укажите ID сессии (например 4102) — без него сохранение в БД невозможно', type: 'error' })
      return
    }

    setStatus({ text: `Читаю разметку ${file.name}…`, type: 'loading' })
    setRelabelStep(null)
    setSelectedMarkup(null)

    try {
      if (token) {
        await fetchSessionMarkupsFromDb(sid)
      }

      const text = await file.text()
      const { headers, rows } = parseCsvText(text)

      const tCol = headers.find(c => c === 'Time')
        || headers.find(c => ['time', 'timestamp', 'Timestamp', 't'].includes(c))
      if (!tCol) throw new Error('Колонка Time не найдена в CSV')

      const hasTarget = headers.some(c => ['Target', 'target', 'Label', 'label'].includes(c))
      if (!hasTarget) throw new Error('Колонка Target не найдена — это не размеченный CSV')

      const leftSensor = insoleSensorNames[0]
      const rightSensor = insoleSensorNames[1]
      if (!leftSensor) throw new Error('В данных сессии нет сенсоров стельки')

      const csvNames = new Set(rows.map(r => r.Name || r.name).filter(Boolean))
      const resolveSensor = (preferred, fallback) => {
        if (csvNames.has(preferred)) return preferred
        if (fallback && csvNames.has(fallback)) return fallback
        return preferred
      }
      const leftName = resolveSensor(leftSensor, 'ESP32_Sensor_1')
      const rightName = rightSensor
        ? resolveSensor(rightSensor, 'ESP32_Sensor_2')
        : null

      const { leftContacts: importedLeft, rightContacts: importedRight, leftCount, rightCount } =
        extractContactsFromLabeledCsv(
          rows,
          tCol,
          leftName,
          rightName || '__none__',
          offsetS1Ref.current,
          offsetS2Ref.current,
        )

      if (leftCount === 0 && rightCount === 0) {
        throw new Error('В CSV нет интервалов с Target=1')
      }

      setLeftContacts(importedLeft)
      setRightContacts(importedRight)
      setActiveMarkupFileId('new')
      setPendingImportFilename(file.name.replace(/\.csv$/i, '') + '.csv')
      skipClearImportCsvRef.current = true
      importedCsvTextRef.current = text
      setLabelingMode(true)
      setShowLeftPatterns(true)
      setShowRightPatterns(true)
      if (!sessionLabel.startsWith('Сессия #')) {
        setSessionLabel(`Сессия #${sid}`)
      }

      setStatus({
        text: `✓ Импорт ${file.name}: S1 ${leftCount} · S2 ${rightCount}. Нажмите «Сохранить в БД».`,
        type: 'ok',
      })
    } catch (err) {
      setStatus({ text: `Ошибка импорта CSV: ${err.message}`, type: 'error' })
    }
  }, [parquetData, insoleSensorNames, sessionId, token, fetchSessionMarkupsFromDb, sessionLabel])

  // ── Video zoom helpers ────────────────────────────────────────────────────
  const clampPan = useCallback((z, px, py) => {
    const el = videoWrapRef.current
    if (!el) return [px, py]
    const maxX = el.clientWidth  * (z - 1) / (2 * z)
    const maxY = el.clientHeight * (z - 1) / (2 * z)
    return [
      Math.max(-maxX, Math.min(maxX, px)),
      Math.max(-maxY, Math.min(maxY, py)),
    ]
  }, [])

  const resetZoom = useCallback(() => { setZoom(1); setPanX(0); setPanY(0) }, [])

  const changeZoom = useCallback((factor) => {
    setZoom(prevZ => {
      const newZ = Math.max(1, Math.min(8, prevZ * factor))
      setPanX(px => {
        setPanY(py => {
          const [cx, cy] = clampPan(newZ, px, py)
          setPanX(cx); setPanY(cy); return cy
        })
        return px
      })
      if (newZ === 1) { setPanX(0); setPanY(0) }
      return newZ
    })
  }, [clampPan])

  const handleVideoWheel = useCallback((e) => {
    e.preventDefault()
    const rect   = videoWrapRef.current.getBoundingClientRect()
    const cx     = e.clientX - rect.left - rect.width  / 2
    const cy     = e.clientY - rect.top  - rect.height / 2
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
    setZoom(prevZ => {
      const newZ = Math.max(1, Math.min(8, prevZ * factor))
      if (newZ === 1) { setPanX(0); setPanY(0); return 1 }
      setPanX(px => {
        const npx  = px - cx * (1 / newZ - 1 / prevZ)
        const maxX = videoWrapRef.current?.clientWidth  * (newZ - 1) / (2 * newZ) ?? 9999
        return Math.max(-maxX, Math.min(maxX, npx))
      })
      setPanY(py => {
        const npy  = py - cy * (1 / newZ - 1 / prevZ)
        const maxY = videoWrapRef.current?.clientHeight * (newZ - 1) / (2 * newZ) ?? 9999
        return Math.max(-maxY, Math.min(maxY, npy))
      })
      return newZ
    })
  }, [])

  const handleVideoPanStart = useCallback((e) => {
    if (zoom <= 1) return
    isVideoPan.current = true
    e.preventDefault()
  }, [zoom])

  useEffect(() => {
    const onMove = (e) => {
      if (!isVideoPan.current) return
      setPanX(px => {
        const newPx = px + e.movementX / zoom
        const maxX  = videoWrapRef.current?.clientWidth  * (zoom - 1) / (2 * zoom) ?? 9999
        return Math.max(-maxX, Math.min(maxX, newPx))
      })
      setPanY(py => {
        const newPy = py + e.movementY / zoom
        const maxY  = videoWrapRef.current?.clientHeight * (zoom - 1) / (2 * zoom) ?? 9999
        return Math.max(-maxY, Math.min(maxY, newPy))
      })
    }
    const onUp = () => { isVideoPan.current = false }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [zoom])

  useEffect(() => {
    const el = videoWrapRef.current
    if (!el) return
    el.addEventListener('wheel', handleVideoWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleVideoWheel)
  }, [handleVideoWheel])

  // ── Video loader ──────────────────────────────────────────────────────────
  const loadVideo = useCallback((file) => {
    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current)
    const url = URL.createObjectURL(file)
    videoUrlRef.current = url
    setVideoUrl(url)
    setVideoName(file.name)
    setCurrentTime(0)
  }, [])

  // ── Parquet loader ────────────────────────────────────────────────────────
  const loadParquetFile = useCallback(async (file) => {
    setStatus({ text: `Читаю ${file.name}…`, type: 'loading' })
    setSessionLabel(file.name)
    setChartReady(false)
    plotInitRef.current = false
    setLeftContacts([])
    setRightContacts([])
    setShowLeftPatterns(true)
    setShowRightPatterns(true)
    setShowSensor1(true)
    setShowSensor2(true)
    setShowSpeedTracker(false)
    setSpeedPredict(null)
    setShowSpeedPredict(false)
    setShowDistancePredict(false)
    calculatorDataVersionRef.current += 1
    setCalculatorResults({})
    setActiveCalculators([])
    setCalculatorLoading('')
    setExtraCalculatorsOpen(false)
    setOffsetST(0)
    setShowGaps(false)
    setCheckHzData(null)
    setSelectedMarkup(null)
    anglesUnwrappedRef.current = false
    setAnglesUnwrapped(false)
    importedCsvTextRef.current = ''
    setPendingImportFilename('')
    setActiveMarkupFileId('')

    try {
      const arrayBuffer = await file.arrayBuffer()
      const rows = await parquetReadObjects({ file: arrayBuffer })

      if (!rows?.length) { setStatus({ text: 'Файл пустой', type: 'error' }); return }

      const colMap = {}
      Object.keys(rows[0]).forEach(k => { colMap[k] = [] })
      rows.forEach(row => Object.entries(row).forEach(([k, v]) => {
        colMap[k].push(typeof v === 'bigint' ? Number(v) : v)
      }))
      const tCol = detectTimeCol(Object.keys(colMap))
      addAccTkeoColumn(colMap, tCol)
      setParquetData(colMap)
      setTimeCol(tCol)

      const names = sortSensorNames(colMap)
      const insole = names.filter(n => n !== SPEED_TRACKER)
      const hasST = names.includes(SPEED_TRACKER)
      setSensorNames(names)

      const numCols = computeNumericColumns(colMap, tCol)
      setColumns(numCols)
      setSelectedCols(buildDefaultCols(numCols, hasST))
      setShowSpeedTracker(hasST)
      setOffsetST(hasST ? computeAutoOffsetST(colMap, tCol, insole) : 0)

      const tVals   = (colMap[tCol] || []).map(safeNum).filter(v => v !== null)
      const tMax    = tVals.length ? arrayMax(tVals) : 0
      const autoUnit = tMax > 3600 ? 'ms' : 's'
      setTimeUnit(autoUnit)
      timeUnitRef.current = autoUnit

      const stHint = hasST ? ' · SpeedTracker' : ''
      setStatus({ text: `✓ ${rows.length} строк · ${numCols.length} колонок · ${autoUnit}${stHint}`, type: 'ok' })

      const sid = sessionId.trim()
      if (sid && token) {
        try {
          const sess = await fetchSessionMarkupsFromDb(sid)
          // The parquet file carries no calibration; if the linked session does,
          // derive the normalized channels now and refresh the column list.
          if (addNormalizedSensorColumns(colMap, sess?.additional_info).length) {
            setParquetData({ ...colMap })
            setColumns(computeNumericColumns(colMap, tCol))
          }
          setSessionLabel(`Сессия #${sid} · ${file.name}`)
        } catch {
          // parquet loaded; markups will load on save
        }
      }
    } catch (err) {
      setStatus({ text: `Ошибка чтения parquet: ${err.message}`, type: 'error' })
    }
  }, [sessionId, token, fetchSessionMarkupsFromDb])

  const handleFiles = useCallback((files) => {
    ;[...files].forEach(f => {
      if (f.type.startsWith('video/') || /\.(mp4|webm|mov|avi|mkv)$/i.test(f.name)) loadVideo(f)
      else if (/\.parquet$/i.test(f.name)) loadParquetFile(f)
      else if (/\.csv$/i.test(f.name)) importLabeledCsv(f)
    })
  }, [loadVideo, loadParquetFile, importLabeledCsv])

  // ── Speed/Distance predict (charts/sprint-speed) ─────────────────────────
  // Both overlays read the same fetched series (it carries speed AND
  // distance per point) — whichever button is clicked first fetches, the
  // other reuses the cached result. Visibility is toggled independently.
  const ensurePredictSeries = useCallback(async () => {
    if (speedPredict) return speedPredict

    const sid = sessionId.trim()
    if (!sid) throw new Error('Укажите ID сессии — прогноз берётся по сессии')

    setPredictLoading(true)
    try {
      const resp = await fetch(`${API_BASE}/api/sessions/${sid}/charts/sprint-speed`, {
        headers: { 'accept': 'application/json', 'Authorization': `Bearer ${token}` },
      })
      if (resp.status === 401) {
        setToken('')
        sessionStorage.removeItem('auth_token')
        throw new Error('Сессия авторизации истекла — войдите снова')
      }
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}))
        throw new Error(parseApiError(errData, resp.status))
      }
      const data = await resp.json()
      if (!data?.data_points?.length) {
        throw new Error('В charts/sprint-speed нет точек для этой сессии')
      }
      setSpeedPredict(data)
      return data
    } finally {
      setPredictLoading(false)
    }
  }, [speedPredict, sessionId, token])

  const fetchSpeedPredict = useCallback(async () => {
    if (showSpeedPredict) { setShowSpeedPredict(false); return }
    try {
      const data = await ensurePredictSeries()
      // Make sure a speed subplot exists to overlay onto.
      const speedCol = columns.find(c => SPEED_PRED_COLS.has(c))
      if (speedCol && !selectedCols.includes(speedCol)) {
        setSelectedCols(prev => [...prev, speedCol])
      }
      setShowSpeedPredict(true)
      const peak = data.stat?.peak_speed
      setStatus({
        text: `✓ speed predict: ${data.data_points.length} точек${peak != null ? ` · пик ${peak.toFixed(2)} m/s` : ''}`,
        type: 'ok',
      })
    } catch (err) {
      setStatus({ text: `Ошибка speed predict: ${err.message}`, type: 'error' })
    }
  }, [showSpeedPredict, ensurePredictSeries, columns, selectedCols])

  const fetchDistancePredict = useCallback(async () => {
    if (showDistancePredict) { setShowDistancePredict(false); return }
    try {
      const data = await ensurePredictSeries()
      // Make sure a distance subplot exists to overlay onto.
      const distCol = columns.find(c => DISTANCE_PRED_COLS.has(c))
      if (distCol && !selectedCols.includes(distCol)) {
        setSelectedCols(prev => [...prev, distCol])
      }
      setShowDistancePredict(true)
      const dist = data.stat?.distance_at_peak_speed
      setStatus({
        text: `✓ distance predict: ${data.data_points.length} точек${dist != null ? ` · на пике скорости ${dist.toFixed(1)} м` : ''}`,
        type: 'ok',
      })
    } catch (err) {
      setStatus({ text: `Ошибка distance predict: ${err.message}`, type: 'error' })
    }
  }, [showDistancePredict, ensurePredictSeries, columns, selectedCols])

  const toggleAdditionalCalculator = useCallback(async (calculatorId) => {
    if (activeCalculators.includes(calculatorId)) {
      setActiveCalculators(prev => prev.filter(id => id !== calculatorId))
      return
    }

    if (calculatorResults[calculatorId]) {
      setActiveCalculators(prev => prev.includes(calculatorId) ? prev : [...prev, calculatorId])
      return
    }

    if (!parquetData || calculatorLoading) return

    const dataVersion = calculatorDataVersionRef.current
    setCalculatorLoading(calculatorId)
    try {
      const resp = await fetch(`/calculator-api/calculate/${calculatorId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'accept': 'application/json' },
        body: JSON.stringify({ rows: colMapToRows(parquetData) }),
      })
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}))
        throw new Error(parseApiError(errData, resp.status))
      }

      const data = await resp.json()
      if (dataVersion !== calculatorDataVersionRef.current) return

      setCalculatorResults(prev => ({ ...prev, [calculatorId]: data }))
      setActiveCalculators(prev => prev.includes(calculatorId) ? prev : [...prev, calculatorId])

      const left = data.summary?.left?.contact_count || 0
      const right = data.summary?.right?.contact_count || 0
      const cadence = data.summary?.cadence_spm
      setStatus({
        text: `✓ ${data.label}: L ${left} · R ${right}${cadence != null ? ` · ${cadence.toFixed(0)} spm` : ''}`,
        type: 'ok',
      })
    } catch (err) {
      if (dataVersion !== calculatorDataVersionRef.current) return
      const localHint = err instanceof TypeError
        ? 'Локальный API калькуляторов недоступен — запустите npm run calculator-api'
        : err.message
      setStatus({ text: `Ошибка калькулятора: ${localHint}`, type: 'error' })
    } finally {
      if (dataVersion === calculatorDataVersionRef.current) setCalculatorLoading('')
    }
  }, [activeCalculators, calculatorResults, parquetData, calculatorLoading])

  // ── Build Plotly chart ────────────────────────────────────────────────────
  const renderChart = useCallback(() => {
    if (!parquetData || !selectedCols.length || !chartDivRef.current) return

    const sensor1Name = insoleSensorNames[0] || ''
    const sensor2Name = insoleSensorNames[1] || ''
    const nameArr = parquetData['Name']

    const filterBySensor = (sName) => {
      if (!nameArr || !sName) return parquetData
      const mask = nameArr.map(v => v === sName)
      const out  = {}
      Object.entries(parquetData).forEach(([k, arr]) => {
        out[k] = arr.filter((_, i) => mask[i])
      })
      return out
    }

    const applyUnwrap = (d) => {
      if (!anglesUnwrappedRef.current || !d) return d
      const out = { ...d }
      selectedCols.forEach(col => { if (out[col]) out[col] = unwrapAngleDegrees(out[col]) })
      return out
    }
    const data1 = applyUnwrap(filterBySensor(sensor1Name))
    const data2 = sensor2Name ? applyUnwrap(filterBySensor(sensor2Name)) : null
    const dataST = hasSpeedTracker ? filterBySensor(SPEED_TRACKER) : null

    const shift1 = offsetS1Ref.current
    const shift2 = offsetS2Ref.current
    const shiftST = offsetSTRef.current
    const tArr1 = (data1[timeCol] || []).map(v => { const n = safeNum(v); return n !== null ? n + shift1 : null })
    const tArr2 = data2 ? (data2[timeCol] || []).map(v => { const n = safeNum(v); return n !== null ? n + shift2 : null }) : []
    const tArrST = dataST
      ? (dataST[timeCol] || []).map(v => { const n = safeNum(v); return n !== null ? n + shiftST : null })
      : []

    const allTVals = [
      ...tArr1,
      ...tArr2,
      ...(showSpeedTrackerRef.current ? tArrST : []),
    ].filter(v => v !== null)
    if (!allTVals.length) {
      setStatus({ text: `Колонка "${timeCol}" пустая`, type: 'error' })
      return
    }
    const xMin = arrayMin(allTVals)
    const xMax = arrayMax(allTVals)

    const n    = selectedCols.length
    const gap  = 0.03
    const subH = (1 - gap * (n - 1)) / n

    const yRanges = {}
    selectedCols.forEach(col => {
      const stOnly = ST_ONLY_COLS.has(col)
      const vals1 = (stOnly || !showSensor1) ? [] : (data1[col] || []).map(safeNum).filter(v => v !== null)
      const vals2 = (stOnly || !data2 || !showSensor2) ? [] : (data2[col] || []).map(safeNum).filter(v => v !== null)
      let vals  = [...vals1, ...vals2]
      if (dataST && showSpeedTrackerRef.current) {
        const stCol = resolveStDataCol(dataST, col)
        vals = [...vals, ...(dataST[stCol] || []).map(safeNum).filter(v => v !== null)]
      }
      if (!vals.length) { yRanges[col] = [-1, 1]; return }
      const mn = arrayMin(vals), mx = arrayMax(vals)
      const p  = Math.max((mx - mn) * 0.08, 0.1)
      yRanges[col] = [mn - p, mx + p]
    })

    const traces = []
    const s1Idx  = []
    const s2Idx  = []
    const stIdx  = []
    selectedCols.forEach((col, i) => {
      const yAxis = i === 0 ? 'y' : `y${i + 1}`
      const xAxis = `x${i === 0 ? '' : i + 1}`
      const stOnly = ST_ONLY_COLS.has(col)

      if (!stOnly) {
        s1Idx.push(traces.length)
        traces.push({
          x: tArr1,
          y: (data1[col] || []).map(safeNum),
          name: data2 ? `${col} (S1)` : col,
          type: 'scatter', mode: 'lines',
          xaxis: xAxis, yaxis: yAxis,
          line: { color: PALETTE[(2 * i) % PALETTE.length], width: 1.5 },
          connectgaps: false,
          visible: showSensor1,
        })
        if (data2) {
          s2Idx.push(traces.length)
          traces.push({
            x: tArr2,
            y: (data2[col] || []).map(safeNum),
            name: `${col} (S2)`,
            type: 'scatter', mode: 'lines',
            xaxis: xAxis, yaxis: yAxis,
            line: { color: PALETTE[(2 * i + 1) % PALETTE.length], width: 1.5 },
            connectgaps: false,
            visible: showSensor2,
          })
        }
      }

      if (dataST) {
        const stCol = resolveStDataCol(dataST, col)
        const yST = (dataST[stCol] || []).map(safeNum)
        if (yST.some(v => v !== null)) {
          stIdx.push(traces.length)
          traces.push({
            x: tArrST,
            y: yST,
            name: `${col} (ST)`,
            type: 'scatter', mode: 'lines',
            xaxis: xAxis, yaxis: yAxis,
            line: { color: ST_COL_COLORS[stCol] ?? ST_COLOR, width: stOnly ? 2 : 1.5, dash: stOnly ? 'solid' : 'dot' },
            connectgaps: false,
            visible: showSpeedTrackerRef.current,
          })
        }
      }

      // Speed-predict overlay (charts/sprint-speed) on top of the speed subplot.
      // Backend time is seconds (raw device Time / 1000); the ST trace here plots
      // rawTime + offsetST, so rawTime = point.time * 1000 realigns the two.
      if (SPEED_PRED_COLS.has(col) && showSpeedPredict && speedPredict?.data_points?.length) {
        const shiftST = offsetSTRef.current
        const toX = (tSec) => tSec * 1000 + shiftST
        traces.push({
          x: speedPredict.data_points.map(p => toX(p.time)),
          y: speedPredict.data_points.map(p => p.speed),
          name: 'speed predict',
          type: 'scatter', mode: 'lines',
          xaxis: xAxis, yaxis: yAxis,
          line: { color: PRED_COLOR, width: 2 },
          connectgaps: false,
        })
        const st = speedPredict.stat
        if (st && st.peak_speed != null && st.timestep_at_peak_speed != null) {
          traces.push({
            x: [toX(st.timestep_at_peak_speed)],
            y: [st.peak_speed],
            name: `пик ${st.peak_speed.toFixed(2)} m/s`,
            type: 'scatter', mode: 'markers',
            xaxis: xAxis, yaxis: yAxis,
            marker: { color: PRED_COLOR, size: 11, symbol: 'star', line: { color: '#fff', width: 1 } },
          })
        }
      }

      // Distance-predict overlay (same fetched series, cumulative distance).
      if (DISTANCE_PRED_COLS.has(col) && showDistancePredict && speedPredict?.data_points?.length) {
        const shiftST = offsetSTRef.current
        const toX = (tSec) => tSec * 1000 + shiftST
        traces.push({
          x: speedPredict.data_points.map(p => toX(p.time)),
          y: speedPredict.data_points.map(p => p.distance),
          name: 'distance predict',
          type: 'scatter', mode: 'lines',
          xaxis: xAxis, yaxis: yAxis,
          line: { color: PRED_COLOR, width: 2 },
          connectgaps: false,
        })
        const st = speedPredict.stat
        if (st && st.distance_at_peak_speed != null && st.timestep_at_peak_speed != null) {
          traces.push({
            x: [toX(st.timestep_at_peak_speed)],
            y: [st.distance_at_peak_speed],
            name: `${st.distance_at_peak_speed.toFixed(1)} м на пике скорости`,
            type: 'scatter', mode: 'markers',
            xaxis: xAxis, yaxis: yAxis,
            marker: { color: PRED_COLOR, size: 11, symbol: 'star', line: { color: '#fff', width: 1 } },
          })
        }
      }
    })
    s1TraceIdxRef.current = s1Idx
    s2TraceIdxRef.current = s2Idx
    stTraceIdxRef.current = stIdx

    cursorShapesRef.current  = buildCursorShapes(xMin, n)
    contactShapesRef.current = []
    gapShapesRef.current     = []
    lastTRef.current         = null
    plotInitRef.current      = false

    const layout = {
      shapes: cursorShapesRef.current,
      xaxis: {},
      margin: { t: 12, l: 60, r: 16, b: 42 },
      plot_bgcolor: '#f8f9fa',
      paper_bgcolor: '#fff',
      showlegend: true,
      dragmode: 'pan',
      legend: { orientation: 'h', y: -0.06, font: { size: 11 } },
    }

    selectedCols.forEach((col, i) => {
      const top    = 1 - i * (subH + gap)
      const bottom = top - subH
      const yKey   = i === 0 ? 'yaxis'  : `yaxis${i + 1}`
      const xKey   = i === 0 ? 'xaxis'  : `xaxis${i + 1}`

      layout[yKey] = {
        domain:    [Math.max(0, bottom), Math.min(1, top)],
        title:     { text: col, font: { size: 11 } },
        range:     yRanges[col],
        showgrid:  true,
        gridcolor: '#e8e8e8',
        zeroline:  false,
        tickfont:  { size: 10 },
      }
      layout[xKey] = {
        anchor:         `y${i === 0 ? '' : i + 1}`,
        showgrid:        true,
        gridcolor:       '#e8e8e8',
        title:           i === n - 1 ? { text: 'Время', font: { size: 11 } } : undefined,
        tickfont:        { size: 10 },
        matches:         i > 0 ? 'x' : undefined,
        showticklabels:  i === n - 1,
        range:           zoomRangeRef.current || [xMin, xMax],
      }
    })

    Plotly.newPlot(chartDivRef.current, traces, layout, {
      responsive: true,
      displayModeBar: true,
      modeBarButtonsToRemove: ['lasso2d', 'select2d'],
      scrollZoom: true,
    }).then(() => {
      plotInitRef.current = true
      setChartReady(true)
      updateOverlayShapes()
      chartDivRef.current.on('plotly_click', (d) => {
        if (!d?.points?.length) return
        const t = d.points[0].x

        if (relabelStepRef.current === 'start') {
          const sm = selectedMarkupRef.current
          if (sm) {
            const setter = sm.foot === 'left' ? setLeftContacts : setRightContacts
            setter(prev => {
              const next = [...prev]
              if (sm.index < next.length) next[sm.index] = t
              return next
            })
            setRelabelStep('end')
          }
        } else if (relabelStepRef.current === 'end') {
          const sm = selectedMarkupRef.current
          if (sm) {
            const setter = sm.foot === 'left' ? setLeftContacts : setRightContacts
            setter(prev => {
              const next = [...prev]
              if (sm.index + 1 < next.length) next[sm.index + 1] = t
              return next
            })
            setRelabelStep(null)
          }
        } else if (labelingRef.current) {
          if (currentFootRef.current === 'left') setLeftContacts(p => [...p, t])
          else setRightContacts(p => [...p, t])
        } else if (videoRef.current) {
          const scale = timeUnitRef.current === 'ms' ? 1000 : 1
          videoRef.current.currentTime = Math.max(0, t / scale)
        }
      })

      chartDivRef.current.on('plotly_relayout', (eventData) => {
        if (eventData['xaxis.range[0]'] !== undefined && eventData['xaxis.range[1]'] !== undefined) {
          zoomRangeRef.current = [eventData['xaxis.range[0]'], eventData['xaxis.range[1]']]
        } else if (eventData['xaxis.range'] !== undefined) {
          zoomRangeRef.current = eventData['xaxis.range']
        } else if (eventData['xaxis.autorange'] === true) {
          zoomRangeRef.current = null
        }
      })
    })
  }, [parquetData, selectedCols, timeCol, insoleSensorNames, hasSpeedTracker, offsetS1, offsetS2, offsetST, showSpeedTracker, updateOverlayShapes, showSensor1, showSensor2, speedPredict, showSpeedPredict, showDistancePredict])

  const handleUnwrapAngles = useCallback(() => {
    if (!parquetData || !selectedCols.length) return
    anglesUnwrappedRef.current = !anglesUnwrappedRef.current
    setAnglesUnwrapped(anglesUnwrappedRef.current)
    renderChart()
  }, [parquetData, selectedCols, renderChart])

  useEffect(() => {
    if (!plotInitRef.current || !parquetData || !selectedCols.length) return
    renderChart()
  }, [offsetS1, offsetS2, offsetST, showSpeedTracker, showSensor1, showSensor2, renderChart, parquetData, selectedCols.length])

  // ── Video timeupdate → move chart cursor ──────────────────────────────────
  const handleTimeUpdate = useCallback(() => {
    if (!videoRef.current) return
    const t = videoRef.current.currentTime
    setCurrentTime(t)

    if (vidLblRef.current) vidLblRef.current.textContent = formatTime(t)
    const scale = timeUnitRef.current === 'ms' ? 1000 : 1
    const imuT  = t * scale
    if (imuLblRef.current) imuLblRef.current.textContent =
      `IMU ${timeUnitRef.current === 'ms' ? imuT.toFixed(0) + 'ms' : imuT.toFixed(2) + 's'}`

    if (!plotInitRef.current || !chartDivRef.current) return
    if (lastTRef.current !== null && Math.abs(imuT - lastTRef.current) < 0.04) return
    lastTRef.current = imuT

    const n = selectedColsRef.current.length
    if (n === 0) return
    cursorShapesRef.current = buildCursorShapes(imuT, n)
    Plotly.relayout(chartDivRef.current, {
      shapes: [...gapShapesRef.current, ...contactShapesRef.current, ...cursorShapesRef.current],
    })
  }, [])

  // ── Timeline drag ─────────────────────────────────────────────────────────
  const seekFromX = useCallback((clientX) => {
    const rect = timelineRef.current?.getBoundingClientRect()
    if (!rect || !videoRef.current || videoDuration <= 0) return
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width))
    videoRef.current.currentTime = (x / rect.width) * videoDuration
  }, [videoDuration])

  useEffect(() => {
    const onMove = (e) => { if (isDragging.current) seekFromX(e.clientX) }
    const onUp   = () => { isDragging.current = false }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [seekFromX])

  // ── Cleanup ───────────────────────────────────────────────────────────────
  useEffect(() => () => {
    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current)
    if (chartDivRef.current) Plotly.purge(chartDivRef.current)
  }, [])

  // ── Column toggle ─────────────────────────────────────────────────────────
  const toggleCol = (col) =>
    setSelectedCols(p => p.includes(col) ? p.filter(c => c !== col) : [...p, col])

  // ── Computed ──────────────────────────────────────────────────────────────
  const cursorPct = videoDuration > 0 ? (currentTime / videoDuration) * 100 : 0

  const ticks = []
  if (videoDuration > 0) {
    const step = videoDuration <= 30 ? 5 : videoDuration <= 120 ? 15 : videoDuration <= 600 ? 60 : 300
    for (let t = 0; t <= videoDuration; t += step)
      ticks.push({ t, pct: (t / videoDuration) * 100 })
  }

  const totalContacts = leftContacts.length + rightContacts.length

  // ── Login modal ───────────────────────────────────────────────────────────
  if (!token) {
    return (
      <div className="login-backdrop">
        <div className="login-card">
          <div className="login-logo">
            <span className="login-icon">🎬</span>
            <h1 className="login-title">Видео + IMU Viewer</h1>
            <p className="login-sub">MiraiTech Health</p>
          </div>
          <form className="login-form" onSubmit={handleLogin}>
            <label className="login-label">
              Email
              <input
                type="email"
                className="login-input"
                value={loginEmail}
                onChange={e => setLoginEmail(e.target.value)}
                placeholder="admin@miraitech.health"
                required
                autoFocus
              />
            </label>
            <label className="login-label">
              Пароль
              <input
                type="password"
                className="login-input"
                value={loginPassword}
                onChange={e => setLoginPassword(e.target.value)}
                placeholder="••••••••"
                required
              />
            </label>
            {loginError && <p className="login-error">{loginError}</p>}
            <button type="submit" className="login-btn" disabled={authLoading}>
              {authLoading ? 'Вход…' : 'Войти'}
            </button>
          </form>
        </div>
      </div>
    )
  }

  // ── Main UI ───────────────────────────────────────────────────────────────
  return (
    <div
      className={`app${dragOver ? ' drag-over' : ''}`}
      onDrop={e => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files) }}
      onDragOver={e => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
    >
      {/* ── Header ── */}
      <header className="header">
        <div className="header-left">
          <span className="header-icon">🎬</span>
          <span className="header-title">Видео + IMU Viewer</span>
        </div>
        <div className="header-right">
          {videoName    && <FileBadge type="video">📹 {videoName}</FileBadge>}
          {sessionLabel && <FileBadge type="parquet">📊 {sessionLabel}</FileBadge>}
          <button className="logout-btn" onClick={handleLogout} title="Выйти">⏏ Выйти</button>
        </div>
      </header>

      <div className={`app-body${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
        <aside className="sidebar">
          <button
            type="button"
            className="sidebar-collapse-btn"
            onClick={() => setSidebarCollapsed(v => !v)}
            title={sidebarCollapsed ? 'Развернуть панель' : 'Свернуть панель'}
          >
            {sidebarCollapsed ? '▶' : '◀'}
          </button>

          {!sidebarCollapsed && (
            <div className="sidebar-scroll">
              <SidebarSection
                title="1. Данные"
                open={dataPanelOpen}
                onToggle={() => setDataPanelOpen(v => !v)}
              >
                <div className="sidebar-actions">
                  <div className="btn-group btn-group-block">
                    <UploadBtn accept="video/*,.mp4,.webm,.mov,.avi" onFile={loadVideo}>
                      📹 Видео
                    </UploadBtn>
                    <UploadBtn accept=".parquet" onFile={loadParquetFile}>
                      📊 Parquet
                    </UploadBtn>
                    <UploadBtn accept=".csv,text/csv" onFile={importLabeledCsv}>
                      📋 CSV
                    </UploadBtn>
                  </div>

                  <div className="sidebar-field">
                    <span className="sidebar-field-lbl">Сессия</span>
                    <div className="session-group session-group-stack">
                      <div className="session-combo">
                        <input
                          ref={sessionInputRef}
                          type="text"
                          inputMode="numeric"
                          className="input-sm session-input session-input-wide"
                          value={sessionId}
                          onChange={e => { setSessionId(e.target.value); setShowSessionDropdown(true) }}
                          onFocus={() => setShowSessionDropdown(true)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') { setShowSessionDropdown(false); loadSession() }
                            if (e.key === 'Escape') setShowSessionDropdown(false)
                          }}
                          placeholder={sessionsListLoading ? 'Загрузка…' : '3421'}
                          autoComplete="off"
                        />
                        {showSessionDropdown && filteredSessions.length > 0 && (
                          <ul ref={dropdownRef} className="session-dropdown">
                            {filteredSessions.map(s => (
                              <li
                                key={s.id}
                                className={`session-dropdown-item${String(s.id) === sessionId ? ' selected' : ''}`}
                                onMouseDown={e => {
                                  e.preventDefault()
                                  setSessionId(String(s.id))
                                  setShowSessionDropdown(false)
                                }}
                              >
                                <span className="sdi-id">#{s.id}</span>
                                <span className="sdi-name">{s.member_name || '—'}</span>
                                {s.date && <span className="sdi-date">{s.date.slice(0, 10)}</span>}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <button
                        type="button"
                        className="btn-primary btn-block"
                        onClick={() => { setShowSessionDropdown(false); loadSession() }}
                        disabled={!sessionId.trim() || status.type === 'loading'}
                      >
                        ⬇ Загрузить сессию
                      </button>
                    </div>
                  </div>

                  {status.text && (
                    <span className={`status-pill status-${status.type} status-block`}>{status.text}</span>
                  )}
                </div>
              </SidebarSection>

              {columns.length > 0 && (
                <SidebarSection
                  title="2. График"
                  open={chartPanelOpen}
                  onToggle={() => setChartPanelOpen(v => !v)}
                >
                  <div className="sidebar-actions">
                    {(insoleSensorNames.length > 0 || hasSpeedTracker) && (
                      <div className="sidebar-block">
                        <span className="sidebar-block-lbl">Сенсоры</span>
                        <div className="sidebar-chip-list">
                          {insoleSensorNames.map((name, i) => {
                            const isS1      = i === 0
                            const isVisible = isS1 ? showSensor1 : showSensor2
                            const toggle    = () => isS1 ? setShowSensor1(v => !v) : setShowSensor2(v => !v)
                            const color     = isS1 ? PALETTE[0] : '#ff7f0e'
                            const bg        = isS1 ? 'rgba(31,119,180,0.08)' : 'rgba(255,127,14,0.08)'
                            const stats     = checkHzData?.[name]
                            return (
                              <div key={name} className="sensor-group sensor-group-stack">
                                <button
                                  type="button"
                                  className={`btn-toggle sensor-badge${isVisible ? '' : ' sensor-badge-off'}`}
                                  style={isVisible ? { borderColor: color, color, background: bg } : {}}
                                  onClick={toggle}
                                  title={isVisible ? `Скрыть ${name}` : `Показать ${name}`}
                                >
                                  {isVisible ? '●' : '○'}&nbsp;{name.replace('ESP32_', '')}&nbsp;{i === 0 ? '(L)' : '(R)'}
                                </button>
                                {stats && (
                                  <span className="hz-stats hz-stats-compact" style={{ '--hzc': color }}>
                                    <span className="hz-stat-item" title="mean">
                                      <span className="hz-stat-key">μ</span>
                                      <span className="hz-stat-val">{stats.time_diff_mean ?? '—'}</span>
                                    </span>
                                    <span className="hz-stat-sep" />
                                    <span className="hz-stat-item" title="max">
                                      <span className="hz-stat-key">max</span>
                                      <span className="hz-stat-val">{stats.time_diff_max ?? '—'}</span>
                                    </span>
                                  </span>
                                )}
                              </div>
                            )
                          })}
                          {hasSpeedTracker && (
                            <div className="sensor-group sensor-group-stack">
                              <button
                                type="button"
                                className={`btn-toggle sensor-badge sensor-badge-st${showSpeedTracker ? '' : ' sensor-badge-off'}`}
                                style={showSpeedTracker
                                  ? { borderColor: ST_COLOR, color: ST_COLOR, background: 'rgba(44,162,44,0.08)' }
                                  : {}}
                                onClick={() => setShowSpeedTracker(v => !v)}
                              >
                                {showSpeedTracker ? '●' : '○'}&nbsp;SpeedTracker
                              </button>
                              {checkHzData?.[SPEED_TRACKER] && (
                                <span className="hz-stats hz-stats-compact" style={{ '--hzc': ST_COLOR }}>
                                  <span className="hz-stat-item">
                                    <span className="hz-stat-key">μ</span>
                                    <span className="hz-stat-val">{checkHzData[SPEED_TRACKER].time_diff_mean ?? '—'}</span>
                                  </span>
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {(hasSpeedTracker || insoleSensorNames.length > 0) && (
                      <div className="calculator-panel">
                        <span className="sidebar-block-lbl">Калькуляторы</span>
                        {hasSpeedTracker && (
                          <div className="sidebar-block-row calculator-primary-row">
                        <div className="sidebar-block">
                          <span className="sidebar-block-lbl">Прогноз скорости</span>
                          <button
                            type="button"
                            className={`btn-secondary btn-speed-predict${showSpeedPredict ? ' active' : ''}`}
                            onClick={fetchSpeedPredict}
                            disabled={predictLoading || !sessionId.trim()}
                            title={!sessionId.trim()
                              ? 'Укажите ID сессии — прогноз берётся по сессии (charts/sprint-speed)'
                              : showSpeedPredict
                                ? 'Убрать прогноз скорости с графика'
                                : 'Загрузить charts/sprint-speed и наложить поверх колонки Speed'}
                          >
                            {predictLoading
                              ? '⏳ Загрузка…'
                              : showSpeedPredict
                                ? '✕ Убрать speed predict'
                                : '⚡ Speed predict'}
                          </button>
                          {showSpeedPredict && speedPredict?.stat && (
                            <span className="hz-stats hz-stats-compact" style={{ '--hzc': PRED_COLOR }}>
                              {speedPredict.stat.peak_speed != null && (
                                <span className="hz-stat-item" title="пиковая скорость">
                                  <span className="hz-stat-key">пик</span>
                                  <span className="hz-stat-val">{speedPredict.stat.peak_speed.toFixed(2)}</span>
                                </span>
                              )}
                              {speedPredict.stat.average_speed != null && (
                                <>
                                  <span className="hz-stat-sep" />
                                  <span className="hz-stat-item" title="средняя скорость на участке 30 м">
                                    <span className="hz-stat-key">ср</span>
                                    <span className="hz-stat-val">{speedPredict.stat.average_speed.toFixed(2)}</span>
                                  </span>
                                </>
                              )}
                              {speedPredict.stat.duration != null && (
                                <>
                                  <span className="hz-stat-sep" />
                                  <span className="hz-stat-item" title="время прохождения 30 м, с">
                                    <span className="hz-stat-key">30м</span>
                                    <span className="hz-stat-val">{speedPredict.stat.duration.toFixed(2)}с</span>
                                  </span>
                                </>
                              )}
                            </span>
                          )}
                        </div>

                        <div className="sidebar-block">
                          <span className="sidebar-block-lbl">Прогноз дистанции</span>
                          <button
                            type="button"
                            className={`btn-secondary btn-distance-predict${showDistancePredict ? ' active' : ''}`}
                            onClick={fetchDistancePredict}
                            disabled={predictLoading || !sessionId.trim()}
                            title={!sessionId.trim()
                              ? 'Укажите ID сессии — прогноз берётся по сессии (charts/sprint-speed)'
                              : showDistancePredict
                                ? 'Убрать прогноз дистанции с графика'
                                : 'Загрузить charts/sprint-speed и наложить поверх колонки Distance'}
                          >
                            {predictLoading
                              ? '⏳ Загрузка…'
                              : showDistancePredict
                                ? '✕ Убрать distance predict'
                                : '📏 Distance predict'}
                          </button>
                          {showDistancePredict && speedPredict?.stat && (
                            <span className="hz-stats hz-stats-compact" style={{ '--hzc': PRED_COLOR }}>
                              {speedPredict.stat.distance_at_peak_speed != null && (
                                <span className="hz-stat-item" title="дистанция на момент пика скорости">
                                  <span className="hz-stat-key">на пике</span>
                                  <span className="hz-stat-val">{speedPredict.stat.distance_at_peak_speed.toFixed(1)}м</span>
                                </span>
                              )}
                              {speedPredict.stat.duration != null && (
                                <>
                                  <span className="hz-stat-sep" />
                                  <span className="hz-stat-item" title="время прохождения 30 м, с">
                                    <span className="hz-stat-key">30м</span>
                                    <span className="hz-stat-val">{speedPredict.stat.duration.toFixed(2)}с</span>
                                  </span>
                                </>
                              )}
                            </span>
                          )}
                        </div>
                          </div>
                        )}

                        <button
                          type="button"
                          className={`calculator-expand${extraCalculatorsOpen ? ' open' : ''}`}
                          onClick={() => setExtraCalculatorsOpen(open => !open)}
                          aria-expanded={extraCalculatorsOpen}
                          aria-controls="extra-calculators"
                        >
                          <span>
                            Другие калькуляторы
                            {activeCalculators.length > 0 && (
                              <span className="calculator-active-count">{activeCalculators.length}</span>
                            )}
                          </span>
                          <span className="calculator-expand-chevron">⌄</span>
                        </button>

                        {extraCalculatorsOpen && (
                          <div id="extra-calculators" className="calculator-options">
                            {EXTRA_CALCULATORS.map(calculator => {
                              const active = activeCalculators.includes(calculator.id)
                              const loading = calculatorLoading === calculator.id
                              const result = calculatorResults[calculator.id]
                              const summary = result?.summary
                              const leftCount = summary?.left?.contact_count || 0
                              const rightCount = summary?.right?.contact_count || 0
                              return (
                                <div key={calculator.id} className="calculator-option">
                                  <button
                                    type="button"
                                    className={`btn-secondary btn-calculator${active ? ' active' : ''}`}
                                    style={{ '--calculator-color': calculator.color }}
                                    disabled={!parquetData || !!calculatorLoading}
                                    onClick={() => toggleAdditionalCalculator(calculator.id)}
                                    title={active
                                      ? `Убрать ${calculator.label} с графика`
                                      : `Запустить ${calculator.label} для загруженных данных`}
                                  >
                                    <span className="calculator-dot" />
                                    {loading ? 'Считаю…' : active ? `Убрать ${calculator.label}` : calculator.label}
                                  </button>
                                  <span className="calculator-description">{calculator.description}</span>
                                  {result && (
                                    <span className="calculator-summary" style={{ '--calculator-color': calculator.color }}>
                                      L {leftCount} · R {rightCount}
                                      {summary?.cadence_spm != null && ` · ${summary.cadence_spm.toFixed(0)} spm`}
                                      {summary?.left?.mean_contact_duration_s != null
                                        && ` · GCT L ${(summary.left.mean_contact_duration_s * 1000).toFixed(0)} ms`}
                                    </span>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )}

                    <div className="sidebar-block">
                      <span className="sidebar-block-lbl">Колонки</span>
                      <div className="sidebar-chip-list">
                        {columns.map(col => (
                          <button
                            type="button"
                            key={col}
                            className={`btn-toggle col-chip${selectedCols.includes(col) ? ' active' : ''}`}
                            style={selectedCols.includes(col)
                              ? { '--c': PALETTE[selectedCols.indexOf(col) % PALETTE.length] } : {}}
                            onClick={() => toggleCol(col)}
                          >{col}</button>
                        ))}
                      </div>
                      <div className="btn-group btn-group-sm">
                        <button type="button" className="btn-toggle col-chip ghost" onClick={() => setSelectedCols([...columns])}>все</button>
                        <button type="button" className="btn-toggle col-chip ghost" onClick={() => setSelectedCols([])}>сброс</button>
                      </div>
                    </div>

                    <div className="sidebar-block">
                      <span className="sidebar-block-lbl">Сдвиги</span>
                      <div className="offset-grid">
                        <span className="offset-pair">
                          <span className="offset-lbl offset-lbl-s1">S1</span>
                          <OffsetInput
                            value={offsetS1}
                            step={timeUnit === 'ms' ? 100 : 0.05}
                            title="Сдвиг Sensor 1 (левая нога)"
                            onChange={setOffsetS1}
                          />
                        </span>
                        <span className="offset-pair">
                          <span className="offset-lbl offset-lbl-s2">S2</span>
                          <OffsetInput
                            value={offsetS2}
                            step={timeUnit === 'ms' ? 100 : 0.05}
                            title="Сдвиг Sensor 2 (правая нога)"
                            onChange={setOffsetS2}
                          />
                        </span>
                        {hasSpeedTracker && (
                          <span className="offset-pair">
                            <span className="offset-lbl offset-lbl-st">ST</span>
                            <OffsetInput
                              value={offsetST}
                              step={timeUnit === 'ms' ? 100 : 0.05}
                              title="Сдвиг SpeedTracker"
                              onChange={setOffsetST}
                            />
                          </span>
                        )}
                      </div>
                      <div className="sidebar-row">
                        <div className="btn-group">
                          <button type="button" className={`btn-toggle unit-btn${timeUnit === 's'  ? ' active' : ''}`} onClick={() => setTimeUnit('s')}>с</button>
                          <button type="button" className={`btn-toggle unit-btn${timeUnit === 'ms' ? ' active' : ''}`} onClick={() => setTimeUnit('ms')}>мс</button>
                        </div>
                        <button
                          type="button"
                          className={`btn-secondary btn-unwrap${anglesUnwrapped ? ' active' : ''}`}
                          disabled={!selectedCols.length}
                          onClick={handleUnwrapAngles}
                          title={anglesUnwrapped ? 'Вернуть исходные углы' : 'Развернуть углы'}
                        >
                          ↺ Углы
                        </button>
                      </div>
                    </div>

                    <button
                      type="button"
                      className="btn-primary btn-block"
                      disabled={!selectedCols.length}
                      onClick={renderChart}
                    >
                      ▶ Построить график
                    </button>
                  </div>
                </SidebarSection>
              )}
            </div>
          )}
        </aside>

        <div className="main-area">
      {/* ── Content ── */}
      <div className="content">

        {/* Left: video */}
        <div className="video-side">
          <div
            ref={videoWrapRef}
            className={`video-wrap${zoom > 1 ? ' zoomed' : ''}`}
            onMouseDown={handleVideoPanStart}
          >
            {videoUrl ? (
              <div
                className="video-transform"
                style={{
                  transform: `scale(${zoom}) translate(${panX}px, ${panY}px)`,
                  transformOrigin: 'center center',
                  cursor: zoom > 1 ? 'grab' : 'default',
                }}
              >
                <video
                  ref={videoRef}
                  src={videoUrl}
                  controls
                  className="video-el"
                  onLoadedMetadata={e => setVideoDuration(e.target.duration)}
                  onTimeUpdate={handleTimeUpdate}
                />
              </div>
            ) : (
              <div className="drop-hint">
                <span>📹</span>
                <p>Перетащите видео или загрузите в панели слева</p>
              </div>
            )}

            {videoUrl && (
              <div className="zoom-overlay">
                <button className="zoom-btn" onClick={() => changeZoom(1.25)} title="Приблизить">＋</button>
                <span className="zoom-label">{zoom.toFixed(1)}×</span>
                <button className="zoom-btn" onClick={() => changeZoom(1 / 1.25)} title="Отдалить">－</button>
                {zoom > 1 && (
                  <button className="zoom-btn zoom-reset" onClick={resetZoom} title="Сбросить масштаб">⊠</button>
                )}
              </div>
            )}
          </div>

          <div className="time-bar">
            <span ref={vidLblRef} className="time-lbl">0:00.0</span>
            <span ref={imuLblRef} className="time-lbl imu-lbl">IMU 0.00s</span>
            <span className="time-lbl muted">S1:{offsetS1} S2:{offsetS2}{hasSpeedTracker ? ` ST:${offsetST}` : ''}{timeUnit === 'ms' ? 'мс' : 'с'}</span>
            <span className="time-lbl muted dur">{formatTime(videoDuration)}</span>
          </div>

          {videoDuration > 0 && (
            <div
              className="timeline"
              ref={timelineRef}
              onMouseDown={e => { isDragging.current = true; seekFromX(e.clientX) }}
            >
              <div className="tl-played" style={{ width: `${cursorPct}%` }} />
              {ticks.map(({ t, pct }) => (
                <div key={t} className="tl-tick" style={{ left: `${pct}%` }}>
                  <div className="tl-tick-line" />
                  <span className="tl-tick-lbl">{formatTime(t)}</span>
                </div>
              ))}
              <div className="tl-cursor" style={{ left: `${cursorPct}%` }}>
                <div className="tl-cursor-head" />
                <div className="tl-cursor-line" />
              </div>
            </div>
          )}
        </div>

        {/* Right: labeling + chart */}
        <div className="chart-side">
          <div className="label-panel">
            <div className="label-toolbar-row">
              <div className="label-toolbar-group">
                <button
                  type="button"
                  className={`btn-toggle lab-mode-btn${labelingMode ? ' active' : ''}`}
                  onClick={() => setLabelingMode(m => !m)}
                  title={labelingMode ? 'Выключить режим разметки' : 'Включить режим разметки'}
                >
                  ✏ {labelingMode ? 'Разметка вкл' : 'Разметка'}
                </button>

                <button
                  type="button"
                  className={`btn-toggle gap-vis-btn${showGaps ? ' vis-on' : ''}`}
                  onClick={() => setShowGaps(v => !v)}
                  disabled={!checkHzData || totalGaps === 0 || !chartReady}
                  title={
                    !checkHzData
                      ? 'Загрузите сессию для анализа пропусков'
                      : totalGaps === 0
                        ? 'Пропусков в данных не обнаружено'
                        : showGaps
                          ? 'Скрыть пропуски на графике'
                          : `Показать ${totalGaps} пропуск(ов) красными отрезками`
                  }
                >
                  {showGaps ? '●' : '○'}&nbsp;Пропуски{totalGaps > 0 ? ` (${totalGaps})` : ''}
                </button>

                {totalContacts > 0 && (
                  <div className="btn-group">
                    <button
                      type="button"
                      className={`btn-toggle pattern-vis-btn${showLeftPatterns ? ' vis-on' : ''}`}
                      style={{ '--pc': L_LINE }}
                      onClick={() => setShowLeftPatterns(v => !v)}
                      title={showLeftPatterns ? 'Скрыть паттерны Sensor 1' : 'Показать паттерны Sensor 1'}
                    >
                      S1
                    </button>
                    <button
                      type="button"
                      className={`btn-toggle pattern-vis-btn${showRightPatterns ? ' vis-on' : ''}`}
                      style={{ '--pc': R_LINE }}
                      onClick={() => setShowRightPatterns(v => !v)}
                      title={showRightPatterns ? 'Скрыть паттерны Sensor 2' : 'Показать паттерны Sensor 2'}
                    >
                      S2
                    </button>
                  </div>
                )}
              </div>

              <div className="label-toolbar-group label-toolbar-actions">
                {(markupFiles.length > 0 || activeMarkupFileId === 'new' || pendingImportFilename) && (
                  <select
                    className="select-sm markup-file-select"
                    value={activeMarkupFileId || 'new'}
                    onChange={e => handleSelectMarkupFile(e.target.value)}
                    title="Выберите версию разметки из БД"
                  >
                    {markupFiles.map(f => (
                      <option key={f.id} value={f.id}>
                        {f.filename} ({new Date(f.updated_at).toLocaleString()})
                      </option>
                    ))}
                    <option value="new">
                      {pendingImportFilename ? `⬆ ${pendingImportFilename}` : '+ Новая разметка'}
                    </option>
                  </select>
                )}
                {labelingMode && (
                  <span className="lab-stat lab-stat-inline">
                    <span className="lab-stat-l">S1: {Math.floor(leftContacts.length / 2)}</span>
                    <span className="lab-stat-sep">·</span>
                    <span className="lab-stat-r">S2: {Math.floor(rightContacts.length / 2)}</span>
                  </span>
                )}
                <button
                  type="button"
                  className="btn-primary lab-btn save-db"
                  onClick={saveMarkupToDb}
                  disabled={isSaving || !sessionId.trim() || totalContacts === 0}
                  title={!sessionId.trim()
                    ? 'Укажите ID сессии слева (например 4102)'
                    : 'Сохранить текущую разметку в БД (сессия #' + sessionId.trim() + ')'}
                >
                  {isSaving ? 'Сохранение…' : '💾 Сохранить в БД'}
                </button>
                <UploadBtn
                  accept=".csv,text/csv"
                  onFile={importLabeledCsv}
                  className="btn-secondary lab-btn import"
                  disabled={!parquetData}
                  title={parquetData
                    ? 'Загрузить размеченный CSV (Target) и восстановить интервалы на графике'
                    : 'Сначала загрузите сессию или parquet'}
                >
                  ⬆ CSV
                </UploadBtn>
                <button
                  type="button"
                  className="btn-secondary lab-btn export"
                  onClick={exportLabels}
                  disabled={totalContacts === 0}
                  title="Скачать CSV с разметкой Target"
                >
                  ⬇ CSV
                </button>
              </div>
            </div>

            {labelingMode && (
              <div className="label-toolbar-row label-toolbar-row-secondary">
                <div className="label-toolbar-group">
                  <div className="btn-group foot-toggle">
                    <button
                      type="button"
                      className={`foot-btn${currentFoot === 'left' ? ' active left-active' : ''}`}
                      onClick={() => setCurrentFoot('left')}
                    >
                      ◀ S1&nbsp;<span className="foot-count">{leftContacts.length}</span>
                    </button>
                    <button
                      type="button"
                      className={`foot-btn${currentFoot === 'right' ? ' active right-active' : ''}`}
                      onClick={() => setCurrentFoot('right')}
                    >
                      S2&nbsp;<span className="foot-count">{rightContacts.length}</span>&nbsp;▶
                    </button>
                  </div>

                  <button type="button" className="btn-secondary lab-btn" onClick={undoContact} title="Отменить последний клик">
                    ↩ Отмена
                  </button>

                  <div className="lab-menu-wrap" ref={labMenuRef}>
                    <button
                      type="button"
                      className="btn-secondary lab-btn lab-menu-trigger"
                      onClick={() => setLabMenuOpen(v => !v)}
                      title="Дополнительные действия"
                    >
                      ⋯
                    </button>
                    {labMenuOpen && (
                      <div className="lab-menu">
                        <button
                          type="button"
                          className="lab-menu-item"
                          onClick={() => { clearCurrentContacts(); setLabMenuOpen(false) }}
                        >
                          Очистить текущую ногу
                        </button>
                        <button
                          type="button"
                          className="lab-menu-item danger"
                          onClick={() => { clearAllContacts(); setLabMenuOpen(false) }}
                        >
                          Очистить всё
                        </button>
                        <button
                          type="button"
                          className="lab-menu-item danger"
                          disabled={!selectedMarkup}
                          onClick={() => { deleteSelectedMarkup(); setLabMenuOpen(false) }}
                        >
                          Удалить выбранный интервал
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {selectedMarkup && (() => {
                  const contacts = selectedMarkup.foot === 'left' ? leftContacts : rightContacts
                  const pairStart = getPairStartIndex(selectedMarkup.index)
                  const t0 = contacts[pairStart]
                  if (t0 == null) return null
                  const footLabel = selectedMarkup.foot === 'left' ? 'S1' : 'S2'
                  const intervalNum = Math.floor(pairStart / 2) + 1
                  const t1 = contacts[pairStart + 1]
                  const hasPair = pairStart + 1 < contacts.length
                  const fmt = (t) => timeUnit === 'ms' ? `${t.toFixed(0)} мс` : `${t.toFixed(3)} с`
                  const chartCursorTime = currentTime * (timeUnit === 'ms' ? 1000 : 1)

                  const setStartToCursor = () => {
                    const setter = selectedMarkup.foot === 'left' ? setLeftContacts : setRightContacts
                    setter(prev => {
                      const next = [...prev]
                      if (pairStart < next.length) next[pairStart] = chartCursorTime
                      return next
                    })
                  }
                  const setEndToCursor = () => {
                    const setter = selectedMarkup.foot === 'left' ? setLeftContacts : setRightContacts
                    setter(prev => {
                      const next = [...prev]
                      if (pairStart + 1 < next.length) next[pairStart + 1] = chartCursorTime
                      return next
                    })
                  }

                  return (
                    <div className="selected-edit-controls">
                      <span className="lab-stat lab-stat-selected">
                        {footLabel} #{intervalNum}
                        {hasPair ? `: ${fmt(t0)} → ${fmt(t1)}` : `: ${fmt(t0)} (1 точка)`}
                      </span>
                      <div className="btn-group edit-btns">
                        <button
                          type="button"
                          className="btn-secondary btn-xs-edit"
                          onClick={setStartToCursor}
                          title={`Установить начало интервала на текущее время курсора (${fmt(chartCursorTime)})`}
                        >
                          ⏱ Старт в маркер
                        </button>
                        {hasPair && (
                          <button
                            type="button"
                            className="btn-secondary btn-xs-edit"
                            onClick={setEndToCursor}
                            title={`Установить конец интервала на текущее время курсора (${fmt(chartCursorTime)})`}
                          >
                            ⏱ Конец в маркер
                          </button>
                        )}
                        <button
                          type="button"
                          className={`btn-secondary btn-xs-edit${relabelStep ? ' active-relabel' : ''}`}
                          onClick={() => setRelabelStep(relabelStep ? null : 'start')}
                          title="Изменить границы интервала двумя последовательными кликами на графике"
                        >
                          {relabelStep 
                            ? (relabelStep === 'start' ? '📍 Кликните начало...' : '📍 Кликните конец...') 
                            : '🖱 Переразметить кликами'
                          }
                        </button>
                      </div>
                    </div>
                  )
                })()}
              </div>
            )}

            {labelingMode && (leftContacts.length > 0 || rightContacts.length > 0) && (
              <div className="zone-dur-block">
                {[
                  { contacts: leftContacts, cls: 'zone-dur-s1', label: 'S1', foot: 'left' },
                  { contacts: rightContacts, cls: 'zone-dur-s2', label: 'S2', foot: 'right' },
                ].map(({ contacts, cls, label, foot }) => contacts.length > 0 && (
                  <div key={label} className="zone-dur-row">
                    <span className={`zone-dur-label ${cls}`}>{label}</span>
                    {Array.from({ length: Math.floor(contacts.length / 2) }, (_, i) => {
                      const t0 = contacts[i * 2]
                      const t1 = contacts[i * 2 + 1]
                      const dur = Math.abs(t1 - t0)
                      const sel = selectedMarkup?.foot === foot && selectedMarkup.index === i * 2
                      return (
                        <span
                          key={i}
                          className={`zone-dur-chip ${cls}${sel ? ' zone-dur-selected' : ''}`}
                          title={`${t0.toFixed(2)} → ${t1.toFixed(2)}`}
                          onClick={() => {
                            if (selectedMarkup?.foot === foot && selectedMarkup.index === i * 2) {
                              setSelectedMarkup(null)
                            } else {
                              setSelectedMarkup({ foot, index: i * 2 })
                            }
                          }}
                        >
                          #{i + 1}&thinsp;{formatDuration(dur, timeUnit)}
                        </span>
                      )
                    })}
                    {contacts.length % 2 === 1 && (
                      <span
                        className={`zone-dur-chip zone-dur-pending${
                          selectedMarkup?.foot === foot && selectedMarkup.index === contacts.length - 1
                            ? ' zone-dur-selected' : ''
                        }`}
                        onClick={() => {
                          if (selectedMarkup?.foot === foot && selectedMarkup.index === contacts.length - 1) {
                            setSelectedMarkup(null)
                          } else {
                            setSelectedMarkup({ foot, index: contacts.length - 1 })
                          }
                        }}
                      >
                        …2-я точка
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="chart-area">
            <div ref={chartDivRef} style={{ width: '100%', height: '100%' }} />
            {!chartReady && (
              <div className="chart-empty">
                {parquetData
                  ? <><span>📊</span><p>Выберите колонки и нажмите <b>▶ Построить график</b></p></>
                  : <><span>📊</span><p>Загрузите <b>.parquet</b>-файл или введите номер сессии</p></>
                }
              </div>
            )}
          </div>
        </div>
      </div>
        </div>
      </div>

      {dragOver && (
        <div className="drag-overlay">
          <div className="drag-box">⬇<p>Видео, .parquet или размеченный .csv</p></div>
        </div>
      )}
    </div>
  )
}

function SidebarSection({ title, open, onToggle, children }) {
  return (
    <section className="sidebar-section">
      <button type="button" className="sidebar-section-head" onClick={onToggle}>
        <span className="sidebar-section-title">{title}</span>
        <span className="sidebar-section-chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="sidebar-section-body">{children}</div>}
    </section>
  )
}

function UploadBtn({ accept, onFile, children, className = 'btn-upload btn-secondary', disabled = false, title }) {
  return (
    <label
      className={`${className}${disabled ? ' disabled' : ''}`}
      title={title}
      style={disabled ? { opacity: 0.4, pointerEvents: 'none', cursor: 'not-allowed' } : undefined}
    >
      {children}
      <input
        type="file"
        accept={accept}
        hidden
        disabled={disabled}
        onChange={e => {
          if (e.target.files[0]) onFile(e.target.files[0])
          e.target.value = ''
        }}
      />
    </label>
  )
}

function FileBadge({ type, children }) {
  return <span className={`file-badge badge-${type}`}>{children}</span>
}

function OffsetInput({ value, step, title, onChange }) {
  const [draft, setDraft] = useState(String(value))
  const committed = useRef(value)

  useEffect(() => {
    if (committed.current !== value) {
      committed.current = value
      setDraft(String(value))
    }
  }, [value])

  const commit = (raw) => {
    const trimmed = raw.trim()
    const n = Number(trimmed)
    if (trimmed !== '' && isFinite(n)) {
      committed.current = n
      onChange(n)
      setDraft(String(n))
    } else {
      setDraft(String(committed.current))
    }
  }

  const nudge = (dir) => {
    const base = isFinite(Number(draft)) ? Number(draft) : committed.current
    const next = Math.round((base + dir * step) * 1e9) / 1e9
    committed.current = next
    onChange(next)
    setDraft(String(next))
  }

  return (
    <div className="offset-input-wrap">
      <input
        type="text"
        inputMode="numeric"
        className="input-sm offset-input-field"
        value={draft}
        title={title}
        onChange={e => setDraft(e.target.value)}
        onBlur={e => commit(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter')     { e.preventDefault(); commit(draft) }
          if (e.key === 'ArrowUp')   { e.preventDefault(); nudge(+1) }
          if (e.key === 'ArrowDown') { e.preventDefault(); nudge(-1) }
        }}
      />
      <div className="offset-spinners">
        <button className="offset-spin-btn" tabIndex={-1} onMouseDown={e => { e.preventDefault(); nudge(+1) }}>▲</button>
        <button className="offset-spin-btn" tabIndex={-1} onMouseDown={e => { e.preventDefault(); nudge(-1) }}>▼</button>
      </div>
    </div>
  )
}
