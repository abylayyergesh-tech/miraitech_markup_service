import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import Plotly from 'plotly.js-dist-min'
import { parquetReadObjects } from 'hyparquet'
import './App.css'

// ── Constants ──────────────────────────────────────────────────────────────
const API_BASE = import.meta.env.VITE_API_BASE ?? 'https://api.miraitech.health'

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
const TURN_COL = 'XData'
const TURN_MIN_CHANGE_DEG = 60
const TURN_ENTER_MAX_MS = 300
const TURN_MAX_DURATION_MS = 700
const TURN_EXIT_SLOW_MS = 30
const TURN_FAST_RATE_DEG_PER_MS = TURN_MIN_CHANGE_DEG / TURN_ENTER_MAX_MS

const L_FILL = 'rgba(31,119,180,0.35)'
const R_FILL = 'rgba(255,127,14,0.35)'
const L_TURN_FILL = 'rgba(31,119,180,0.5)'
const R_TURN_FILL = 'rgba(255,127,14,0.5)'
const L_LINE = 'rgba(31,119,180,0.9)'
const R_LINE = 'rgba(255,127,14,0.9)'
const GAP_FILL = 'rgba(220,53,69,0.35)'
const GAP_LINE = 'rgba(220,53,69,0.92)'
const SEL_FILL = 'rgba(234,179,8,0.5)'
const SEL_LINE = '#ca8a04'

function buildBandShapes(intervals, nSubplots, fillcolor, linecolor) {
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
        fillcolor,
        line: { color: linecolor, width: 1.5 },
        layer: 'below',
      })
    }
  }
  return shapes
}

function buildTurnBandShapesForSubplot(intervals, subplotIdx, fillcolor, linecolor) {
  if (!intervals.length || subplotIdx < 0) return []
  const yref = subplotIdx === 0 ? 'y domain' : `y${subplotIdx + 1} domain`
  const shapes = []
  for (let [x0, x1] of intervals) {
    if (x1 < x0) [x0, x1] = [x1, x0]
    if (x1 <= x0) continue
    shapes.push({
      type: 'rect',
      x0, x1,
      xref: 'x',
      y0: 0, y1: 1,
      yref,
      fillcolor,
      line: { color: linecolor, width: 0 },
      layer: 'below',
    })
  }
  return shapes
}

function buildGapBandShapes(intervals, nSubplots) {
  return buildBandShapes(intervals, nSubplots, GAP_FILL, GAP_LINE)
}

function resolveTurnCols(allCols) {
  const match = allCols.find(c => c.toLowerCase() === TURN_COL.toLowerCase())
  return match ? [match] : []
}

function sortSensorDataByTime(data, timeCol) {
  const tArr = data[timeCol] || []
  const indices = tArr
    .map((_, i) => i)
    .filter(i => safeNum(tArr[i]) !== null)
    .sort((a, b) => safeNum(tArr[a]) - safeNum(tArr[b]))
  const sorted = {}
  Object.entries(data).forEach(([k, arr]) => {
    sorted[k] = indices.map(i => arr[i])
  })
  return sorted
}

function prepareSensorTurnData(parquetData, sensorName, sensorIndex, timeCol, angleCols) {
  const filtered = filterParquetBySensor(parquetData, sensorName, sensorIndex)
  const sorted = sortSensorDataByTime(filtered, timeCol)
  const availCols = angleCols.filter(c => sorted[c]?.length)
  if (!availCols.length || !(sorted[timeCol] || []).length) return null

  return { data: sorted, timeArr: sorted[timeCol], availCols }
}

function filterParquetBySensor(parquetData, sensorName, sensorIndex = -1) {
  const nameArr = parquetData?.Name
  if (!nameArr) return parquetData

  const uniqueNames = [...new Set(nameArr.filter(v => v != null && v !== ''))].sort((a, b) =>
    a.localeCompare(b),
  )

  let targetName = sensorName
  if (!targetName && sensorIndex >= 0) targetName = uniqueNames[sensorIndex] || ''
  if (!targetName) return parquetData

  let mask = nameArr.map(v => v === targetName)
  if (!mask.some(Boolean)) {
    const suffix = String(targetName).match(/Sensor[_ ]?(\d+)/i)?.[1]
    if (suffix) {
      mask = nameArr.map(v => new RegExp(`Sensor[_ ]?${suffix}\\b`, 'i').test(String(v)))
    }
  }
  if (!mask.some(Boolean) && sensorIndex >= 0 && uniqueNames[sensorIndex]) {
    mask = nameArr.map(v => v === uniqueNames[sensorIndex])
  }

  const out = {}
  Object.entries(parquetData).forEach(([k, arr]) => {
    out[k] = arr.filter((_, i) => mask[i])
  })
  return out
}

function prepareAxisSeriesForTurns(values) {
  return unwrapAngleDegrees(values || [])
}

function inferTimeIsMs(timeArr) {
  const vals = (timeArr || []).map(safeNum).filter(v => v !== null)
  if (!vals.length) return true
  return Math.max(...vals) > 3600
}

function windowDurationUnits(isMs, ms) {
  return isMs ? ms : ms / 1000
}

function sampleRateDegPerUnit(series, timeArr, i) {
  if (i <= 0) return 0
  const t0 = safeNum(timeArr[i - 1])
  const t1 = safeNum(timeArr[i])
  const v0 = safeNum(series[i - 1])
  const v1 = safeNum(series[i])
  if (t0 === null || t1 === null || v0 === null || v1 === null) return 0
  const dt = t1 - t0
  if (dt <= 0) return 0
  return Math.abs(v1 - v0) / dt
}

function findEnterStartIdx(series, timeArr, i, maxMs, minDeg, isMs) {
  const maxUnits = windowDurationUnits(isMs, maxMs)
  const tEnd = safeNum(timeArr[i])
  const vEnd = safeNum(series[i])
  if (tEnd === null || vEnd === null) return -1

  let startIdx = -1
  for (let j = i - 1; j >= 0; j--) {
    const tStart = safeNum(timeArr[j])
    const vStart = safeNum(series[j])
    if (tStart === null || vStart === null) continue
    if (tEnd - tStart > maxUnits) break
    if (Math.abs(vEnd - vStart) >= minDeg) startIdx = j
  }
  return startIdx
}

function mergeTurnIntervals(intervals) {
  if (!intervals.length) return []
  const sorted = [...intervals].sort((a, b) => a[0] - b[0])
  const merged = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    const [x0, x1] = sorted[i]
    const last = merged[merged.length - 1]
    if (x0 <= last[1]) last[1] = Math.max(last[1], x1)
    else merged.push([x0, x1])
  }
  return merged
}

function detectTurnIntervalsForColumn(timeArr, data, col, timeShift = 0) {
  if (!timeArr?.length || !data[col]?.length) return []

  const series = prepareAxisSeriesForTurns(data[col])
  const isMs = inferTimeIsMs(timeArr)
  const exitSlowUnits = windowDurationUnits(isMs, TURN_EXIT_SLOW_MS)
  const maxDurUnits = windowDurationUnits(isMs, TURN_MAX_DURATION_MS)

  let startIdx = -1
  for (let i = 0; i < series.length; i++) {
    if (safeNum(series[i]) !== null) { startIdx = i; break }
  }
  if (startIdx < 0) return []

  const intervals = []
  let inTurn = false
  let turnStartIdx = -1
  let slowAccum = 0

  const tryCloseTurn = (endIdx) => {
    const t0 = safeNum(timeArr[turnStartIdx])
    let t1 = safeNum(timeArr[endIdx])
    if (t0 !== null && t1 !== null) {
      t1 = Math.min(t1, t0 + maxDurUnits)
      if (t1 > t0) intervals.push([t0 + timeShift, t1 + timeShift])
    }
  }

  const closeTurn = (endIdx) => {
    tryCloseTurn(endIdx)
    inTurn = false
    turnStartIdx = -1
    slowAccum = 0
  }

  for (let i = startIdx; i < series.length; i++) {
    if (!inTurn) {
      const enterIdx = findEnterStartIdx(
        series, timeArr, i, TURN_ENTER_MAX_MS, TURN_MIN_CHANGE_DEG, isMs,
      )
      if (enterIdx >= 0) {
        inTurn = true
        turnStartIdx = enterIdx
        slowAccum = 0
      }
    } else {
      const t0 = safeNum(timeArr[turnStartIdx])
      const t1 = safeNum(timeArr[i])
      if (t0 !== null && t1 !== null && t1 - t0 >= maxDurUnits) {
        closeTurn(i)
        continue
      }

      if (i > 0) {
        const rate = sampleRateDegPerUnit(series, timeArr, i)
        const dt = safeNum(timeArr[i]) - safeNum(timeArr[i - 1])
        if (dt !== null && dt > 0) {
          if (rate < TURN_FAST_RATE_DEG_PER_MS) slowAccum += dt
          else slowAccum = 0

          if (slowAccum >= exitSlowUnits) closeTurn(i)
        }
      }
    }
  }

  if (inTurn && turnStartIdx >= 0) {
    tryCloseTurn(series.length - 1)
  }

  return mergeTurnIntervals(intervals)
}

function detectTurnIntervalsByColumn(timeArr, data, angleCols, timeShift = 0) {
  const byCol = {}
  for (const col of angleCols) {
    if (!data[col]?.length) continue
    byCol[col] = detectTurnIntervalsForColumn(timeArr, data, col, timeShift)
  }
  return byCol
}

function countTurnIntervals(byCol) {
  return Object.values(byCol || {}).reduce((n, ivs) => n + (ivs?.length || 0), 0)
}

const EMPTY_TURN_INTERVALS = { left: {}, right: {} }

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
  const [checkHzData, setCheckHzData]   = useState(null)
  const [selectedCols, setSelectedCols] = useState([])
  const [timeCol, setTimeCol]           = useState('Time')
  const [offsetS1, setOffsetS1]         = useState(0)
  const [offsetS2, setOffsetS2]         = useState(0)
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

  // Labeling
  const [labelingMode, setLabelingMode]           = useState(false)
  const [currentFoot, setCurrentFoot]             = useState('left')
  const [leftContacts, setLeftContacts]           = useState([])
  const [rightContacts, setRightContacts]         = useState([])
  const [showLeftPatterns, setShowLeftPatterns]   = useState(true)
  const [showRightPatterns, setShowRightPatterns] = useState(true)
  const [showGaps, setShowGaps]                   = useState(false)
  const [showTurns, setShowTurns]                 = useState(false)
  const [selectedMarkup, setSelectedMarkup]       = useState(null)
  const [anglesUnwrapped, setAnglesUnwrapped]     = useState(false)

  // Refs
  const videoRef        = useRef(null)
  const videoWrapRef    = useRef(null)
  const chartDivRef     = useRef(null)
  const timelineRef     = useRef(null)
  const videoUrlRef     = useRef(null)
  const offsetS1Ref     = useRef(0)
  const offsetS2Ref     = useRef(0)
  const timeUnitRef     = useRef('ms')
  const lastTRef        = useRef(null)
  const plotInitRef      = useRef(false)
  const contactShapesRef = useRef([])
  const gapShapesRef     = useRef([])
  const turnShapesRef    = useRef([])
  const turnIntervalsRef = useRef(EMPTY_TURN_INTERVALS)
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
  const showTurnsRef     = useRef(false)
  const s1TraceIdxRef    = useRef([])
  const s2TraceIdxRef    = useRef([])
  const selectedMarkupRef = useRef(null)

  useEffect(() => { offsetS1Ref.current    = offsetS1     }, [offsetS1])
  useEffect(() => { offsetS2Ref.current    = offsetS2     }, [offsetS2])
  useEffect(() => { timeUnitRef.current    = timeUnit     }, [timeUnit])
  useEffect(() => { labelingRef.current    = labelingMode }, [labelingMode])
  useEffect(() => { currentFootRef.current = currentFoot  }, [currentFoot])
  useEffect(() => { selectedColsRef.current = selectedCols }, [selectedCols])
  useEffect(() => { showGapsRef.current = showGaps }, [showGaps])
  useEffect(() => { showTurnsRef.current = showTurns }, [showTurns])
  useEffect(() => { anglesUnwrappedRef.current = anglesUnwrapped }, [anglesUnwrapped])
  useEffect(() => { selectedMarkupRef.current = selectedMarkup }, [selectedMarkup])

  useEffect(() => {
    if (!selectedMarkup) return
    const contacts = selectedMarkup.foot === 'left' ? leftContacts : rightContacts
    if (selectedMarkup.index >= contacts.length) setSelectedMarkup(null)
  }, [leftContacts, rightContacts, selectedMarkup])

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
    setShowLeftPatterns(true)
    setShowRightPatterns(true)
    setShowSensor1(true)
    setShowSensor2(true)
    setShowGaps(false)
    setShowTurns(false)
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
      const rows = JSON.parse(result.data)

      if (!rows?.length) { setStatus({ text: 'Сессия пустая', type: 'error' }); return }

      const colMap = {}
      Object.keys(rows[0]).forEach(k => { colMap[k] = [] })
      rows.forEach(row => Object.entries(row).forEach(([k, v]) => colMap[k].push(v)))
      setParquetData(colMap)

      const allCols = Object.keys(colMap)
      const tCol = allCols.find(c => c === 'Time')
             || allCols.find(c => ['time', 'timestamp', 'Timestamp', 't'].includes(c))
             || allCols[0]
      setTimeCol(tCol)

      if (colMap['Name']) {
        const names = [...new Set(colMap['Name'].filter(v => v != null && v !== ''))]
          .sort((a, b) => a.localeCompare(b))
        setSensorNames(names)
      } else {
        setSensorNames([])
      }

      const numCols = allCols.filter(c => {
        if (NON_DATA_COLS.has(c) || c === tCol) return false
        const s = colMap[c].find(v => v != null)
        return s !== undefined && typeof s !== 'string'
      })
      setColumns(numCols)

      const defaults = PREFERRED_COLS.filter(c => numCols.includes(c)).slice(0, 3)
      setSelectedCols(defaults.length ? defaults : numCols.slice(0, 3))

      const tVals   = (colMap[tCol] || []).map(safeNum).filter(v => v !== null)
      const tMax    = tVals.length ? Math.max(...tVals) : 0
      const autoUnit = tMax > 3600 ? 'ms' : 's'
      setTimeUnit(autoUnit)
      timeUnitRef.current = autoUnit

      setStatus({ text: `✓ ${rows.length} строк · ${numCols.length} колонок · ${autoUnit}`, type: 'ok' })

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

  const turnColsResolved = useMemo(() => resolveTurnCols(columns), [columns])
  const hasTurnCol = turnColsResolved.length > 0

  const turnIntervals = useMemo(() => {
    if (!parquetData || !hasTurnCol) return EMPTY_TURN_INTERVALS
    const sensor1Name = sensorNames[0] || ''
    const sensor2Name = sensorNames.length > 1 ? sensorNames[1] : ''

    const computeForSensor = (sensorName, shift, sensorIndex) => {
      const prepared = prepareSensorTurnData(
        parquetData, sensorName, sensorIndex, timeCol, turnColsResolved,
      )
      if (!prepared) return {}
      return detectTurnIntervalsByColumn(
        prepared.timeArr,
        prepared.data,
        prepared.availCols,
        shift,
      )
    }

    return {
      left: computeForSensor(sensor1Name, offsetS1, 0),
      right: sensor2Name ? computeForSensor(sensor2Name, offsetS2, 1) : {},
    }
  }, [parquetData, turnColsResolved, hasTurnCol, sensorNames, timeCol, offsetS1, offsetS2])

  const totalTurns = countTurnIntervals(turnIntervals.left) + countTurnIntervals(turnIntervals.right)

  useEffect(() => {
    turnIntervalsRef.current = turnIntervals
  }, [turnIntervals])

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

    const gapShapes = []
    if (showGapsRef.current && checkHzData) {
      const seen = new Set()
      const intervals = []
      sensorNames.forEach((name, i) => {
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

    const turns = turnIntervalsRef.current
    const turnShapes = []
    if (showTurnsRef.current) {
      selectedColsRef.current.forEach((col, subplotIdx) => {
        if (col.toLowerCase() !== TURN_COL.toLowerCase()) return
        const leftKey = Object.keys(turns.left).find(k => k.toLowerCase() === col.toLowerCase())
        const rightKey = Object.keys(turns.right).find(k => k.toLowerCase() === col.toLowerCase())
        if (showSensor1 && leftKey && turns.left[leftKey]?.length) {
          turnShapes.push(
            ...buildTurnBandShapesForSubplot(turns.left[leftKey], subplotIdx, L_TURN_FILL, L_LINE),
          )
        }
        if (showSensor2 && rightKey && turns.right[rightKey]?.length) {
          turnShapes.push(
            ...buildTurnBandShapesForSubplot(turns.right[rightKey], subplotIdx, R_TURN_FILL, R_LINE),
          )
        }
      })
    }
    turnShapesRef.current = turnShapes

    Plotly.relayout(chartDivRef.current, {
      shapes: [
        ...turnShapesRef.current,
        ...gapShapesRef.current,
        ...contactShapesRef.current,
        ...cursorShapesRef.current,
      ],
    })
  }, [showGaps, showTurns, checkHzData, sensorNames, showSensor1, showSensor2])

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
  }, [showGaps, showTurns, checkHzData, showSensor1, showSensor2, offsetS1, offsetS2, selectedCols, selectedMarkup, turnIntervals, updateOverlayShapes])

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

  const exportLabels = useCallback(() => {
    if (!parquetData) return
    const allCols = Object.keys(parquetData)
    const timeArr = parquetData[timeCol] || []
    const nameArr = parquetData['Name']  || []
    const n = timeArr.length
    const rightSensorName = sensorNames[1] || 'ESP32_Sensor_2'

    const buildIv = (contacts) => {
      const out = []
      for (let i = 0; i + 1 < contacts.length; i += 2)
        out.push([Math.min(contacts[i], contacts[i + 1]), Math.max(contacts[i], contacts[i + 1])])
      return out
    }
    const lIv = buildIv(leftContactsRef.current)
    const rIv = buildIv(rightContactsRef.current)
    const inIv = (t, ivs) => {
      const tv = safeNum(t); if (tv === null) return false
      return ivs.some(([a, b]) => tv >= a && tv <= b)
    }

    const hdr = [...allCols, 'Target'].join(',')
    const rows = []
    for (let i = 0; i < n; i++) {
      const name = nameArr[i] || ''
      const t    = timeArr[i]
      const target = name === rightSensorName
        ? (inIv(t, rIv) ? 1 : 0)
        : (inIv(t, lIv) ? 1 : 0)
      const vals = allCols.map(c => {
        const v = parquetData[c][i]
        return v == null ? '' : String(v)
      })
      vals.push(String(target))
      rows.push(vals.join(','))
    }

    const csv  = hdr + '\n' + rows.join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url
    a.download = (sessionLabel || 'session').replace(/\s+/g, '_') + '_labeled.csv'
    document.body.appendChild(a); a.click()
    document.body.removeChild(a); URL.revokeObjectURL(url)
  }, [parquetData, timeCol, sessionLabel, sensorNames])

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
    setShowGaps(false)
    setShowTurns(false)
    setCheckHzData(null)
    setSelectedMarkup(null)
    anglesUnwrappedRef.current = false
    setAnglesUnwrapped(false)

    try {
      const arrayBuffer = await file.arrayBuffer()
      const rows = await parquetReadObjects({ file: arrayBuffer })

      if (!rows?.length) { setStatus({ text: 'Файл пустой', type: 'error' }); return }

      const colMap = {}
      Object.keys(rows[0]).forEach(k => { colMap[k] = [] })
      rows.forEach(row => Object.entries(row).forEach(([k, v]) => {
        colMap[k].push(typeof v === 'bigint' ? Number(v) : v)
      }))
      setParquetData(colMap)

      const allCols = Object.keys(colMap)
      const tCol = allCols.find(c => c === 'Time')
             || allCols.find(c => ['time', 'timestamp', 'Timestamp', 't'].includes(c))
             || allCols[0]
      setTimeCol(tCol)

      if (colMap['Name']) {
        const names = [...new Set(colMap['Name'].filter(v => v != null && v !== ''))]
          .sort((a, b) => a.localeCompare(b))
        setSensorNames(names)
      } else {
        setSensorNames([])
      }

      const numCols = allCols.filter(c => {
        if (NON_DATA_COLS.has(c) || c === tCol) return false
        const s = colMap[c].find(v => v != null)
        return s !== undefined && typeof s !== 'string'
      })
      setColumns(numCols)

      const defaults = PREFERRED_COLS.filter(c => numCols.includes(c)).slice(0, 3)
      setSelectedCols(defaults.length ? defaults : numCols.slice(0, 3))

      const tVals   = (colMap[tCol] || []).map(safeNum).filter(v => v !== null)
      const tMax    = tVals.length ? Math.max(...tVals) : 0
      const autoUnit = tMax > 3600 ? 'ms' : 's'
      setTimeUnit(autoUnit)
      timeUnitRef.current = autoUnit

      setStatus({ text: `✓ ${rows.length} строк · ${numCols.length} колонок · ${autoUnit}`, type: 'ok' })
    } catch (err) {
      setStatus({ text: `Ошибка чтения parquet: ${err.message}`, type: 'error' })
    }
  }, [])

  const handleFiles = useCallback((files) => {
    ;[...files].forEach(f => {
      if (f.type.startsWith('video/') || /\.(mp4|webm|mov|avi|mkv)$/i.test(f.name)) loadVideo(f)
      else if (/\.parquet$/i.test(f.name)) loadParquetFile(f)
    })
  }, [loadVideo, loadParquetFile])

  // ── Build Plotly chart ────────────────────────────────────────────────────
  const renderChart = useCallback(() => {
    if (!parquetData || !selectedCols.length || !chartDivRef.current) return

    const sensor1Name = sensorNames[0] || ''
    const sensor2Name = sensorNames.length > 1 ? sensorNames[1] : ''
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

    const shift1 = offsetS1Ref.current
    const shift2 = offsetS2Ref.current
    const tArr1 = (data1[timeCol] || []).map(v => { const n = safeNum(v); return n !== null ? n + shift1 : null })
    const tArr2 = data2 ? (data2[timeCol] || []).map(v => { const n = safeNum(v); return n !== null ? n + shift2 : null }) : []

    const allTVals = [...tArr1, ...tArr2].filter(v => v !== null)
    if (!allTVals.length) {
      setStatus({ text: `Колонка "${timeCol}" пустая`, type: 'error' })
      return
    }
    const xMin = Math.min(...allTVals)
    const xMax = Math.max(...allTVals)

    const n    = selectedCols.length
    const gap  = 0.03
    const subH = (1 - gap * (n - 1)) / n

    const yRanges = {}
    selectedCols.forEach(col => {
      const vals1 = (data1[col] || []).map(safeNum).filter(v => v !== null)
      const vals2 = data2 ? (data2[col] || []).map(safeNum).filter(v => v !== null) : []
      const vals  = [...vals1, ...vals2]
      if (!vals.length) { yRanges[col] = [-1, 1]; return }
      const mn = Math.min(...vals), mx = Math.max(...vals)
      const p  = Math.max((mx - mn) * 0.08, 0.1)
      yRanges[col] = [mn - p, mx + p]
    })

    const S2_COLOR = '#ff7f0e'
    const traces = []
    const s1Idx  = []
    const s2Idx  = []
    selectedCols.forEach((col, i) => {
      const yAxis = i === 0 ? 'y' : `y${i + 1}`
      const xAxis = `x${i === 0 ? '' : i + 1}`
      s1Idx.push(traces.length)
      traces.push({
        x: tArr1,
        y: (data1[col] || []).map(safeNum),
        name: data2 ? `${col} (S1)` : col,
        type: 'scatter', mode: 'lines',
        xaxis: xAxis, yaxis: yAxis,
        line: { color: PALETTE[i % PALETTE.length], width: 1.5 },
        connectgaps: false,
      })
      if (data2) {
        s2Idx.push(traces.length)
        traces.push({
          x: tArr2,
          y: (data2[col] || []).map(safeNum),
          name: `${col} (S2)`,
          type: 'scatter', mode: 'lines',
          xaxis: xAxis, yaxis: yAxis,
          line: { color: S2_COLOR, width: 1.5 },
          connectgaps: false,
        })
      }
    })
    s1TraceIdxRef.current = s1Idx
    s2TraceIdxRef.current = s2Idx

    cursorShapesRef.current  = buildCursorShapes(xMin, n)
    contactShapesRef.current = []
    gapShapesRef.current     = []
    turnShapesRef.current    = []
    lastTRef.current         = null
    plotInitRef.current      = false

    const layout = {
      shapes: cursorShapesRef.current,
      xaxis: {},
      margin: { t: 12, l: 60, r: 16, b: 42 },
      plot_bgcolor: '#f8f9fa',
      paper_bgcolor: '#fff',
      showlegend: true,
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
        range:           [xMin, xMax],
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
        if (labelingRef.current) {
          if (currentFootRef.current === 'left') setLeftContacts(p => [...p, t])
          else setRightContacts(p => [...p, t])
        } else if (videoRef.current) {
          const scale = timeUnitRef.current === 'ms' ? 1000 : 1
          videoRef.current.currentTime = Math.max(0, t / scale)
        }
      })
    })
  }, [parquetData, selectedCols, timeCol, sensorNames, offsetS1, offsetS2, updateOverlayShapes])

  const handleUnwrapAngles = useCallback(() => {
    if (!parquetData || !selectedCols.length) return
    anglesUnwrappedRef.current = !anglesUnwrappedRef.current
    setAnglesUnwrapped(anglesUnwrappedRef.current)
    renderChart()
  }, [parquetData, selectedCols, renderChart])

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
      shapes: [
        ...turnShapesRef.current,
        ...gapShapesRef.current,
        ...contactShapesRef.current,
        ...cursorShapesRef.current,
      ],
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

      {/* ── Toolbar ── */}
      <div className="toolbar">
        <UploadBtn accept="video/*,.mp4,.webm,.mov,.avi" onFile={loadVideo}>📹 Видео</UploadBtn>
        <UploadBtn accept=".parquet" onFile={loadParquetFile}>📊 Parquet</UploadBtn>

        <div className="session-group">
          <span className="session-lbl">Сессия №</span>
          <div className="session-combo">
            <input
              ref={sessionInputRef}
              type="text"
              inputMode="numeric"
              className="input-sm session-input"
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
            className="btn-build"
            onClick={() => { setShowSessionDropdown(false); loadSession() }}
            disabled={!sessionId.trim() || status.type === 'loading'}
          >
            ⬇ Загрузить
          </button>
        </div>

        {status.text && <span className={`status-pill status-${status.type}`}>{status.text}</span>}
      </div>

      {/* ── Controls ── */}
      {columns.length > 0 && (
        <div className="controls">
          {sensorNames.length > 0 && (
            <div className="ctrl-row">
              <span className="ctrl-lbl">Сенсоры</span>
              {sensorNames.map((name, i) => {
                const isS1      = i === 0
                const isVisible = isS1 ? showSensor1 : showSensor2
                const toggle    = () => isS1 ? setShowSensor1(v => !v) : setShowSensor2(v => !v)
                const color     = isS1 ? PALETTE[0] : '#ff7f0e'
                const bg        = isS1 ? 'rgba(31,119,180,0.08)' : 'rgba(255,127,14,0.08)'
                const stats     = checkHzData?.[name]
                return (
                  <span key={name} className="sensor-group">
                    <button
                      className={`sensor-badge${isVisible ? '' : ' sensor-badge-off'}`}
                      style={isVisible ? { borderColor: color, color, background: bg } : {}}
                      onClick={toggle}
                      title={isVisible ? `Скрыть ${name}` : `Показать ${name}`}
                    >
                      {isVisible ? '●' : '○'}&nbsp;{name.replace('ESP32_', '')}&nbsp;{i === 0 ? '(left)' : '(right)'}
                    </button>
                    {stats && (
                      <span className="hz-stats" style={{ '--hzc': color }}>
                        <span className="hz-stat-item" title="Среднее время между сэмплами">
                          <span className="hz-stat-key">mean</span>
                          <span className="hz-stat-val">{stats.time_diff_mean ?? '—'}</span>
                        </span>
                        <span className="hz-stat-sep" />
                        <span className="hz-stat-item" title="Максимальное время между сэмплами">
                          <span className="hz-stat-key">max</span>
                          <span className="hz-stat-val">{stats.time_diff_max ?? '—'}</span>
                        </span>
                      </span>
                    )}
                  </span>
                )
              })}
            </div>
          )}

          <div className="ctrl-row">
            <span className="ctrl-lbl">Колонки</span>
            {columns.map(col => (
              <button
                key={col}
                className={`col-chip${selectedCols.includes(col) ? ' active' : ''}`}
                style={selectedCols.includes(col)
                  ? { '--c': PALETTE[selectedCols.indexOf(col) % PALETTE.length] } : {}}
                onClick={() => toggleCol(col)}
              >{col}</button>
            ))}
            <button className="col-chip ghost" onClick={() => setSelectedCols([...columns])}>все</button>
            <button className="col-chip ghost" onClick={() => setSelectedCols([])}>сброс</button>
            <span className="ctrl-sep" />
            <span className="ctrl-lbl" style={{ minWidth: 'unset' }}>↔</span>
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
            <div className="unit-toggle">
              <button className={`unit-btn${timeUnit === 's'  ? ' active' : ''}`} onClick={() => setTimeUnit('s')}>с</button>
              <button className={`unit-btn${timeUnit === 'ms' ? ' active' : ''}`} onClick={() => setTimeUnit('ms')}>мс</button>
            </div>
            <button
              className={`btn-unwrap${anglesUnwrapped ? ' active' : ''}`}
              disabled={!selectedCols.length}
              onClick={handleUnwrapAngles}
              title={anglesUnwrapped ? 'Вернуть исходные углы' : 'Развернуть углы (убрать скачки ±360°)'}
            >
              ↺ {anglesUnwrapped ? 'Углы развёрнуты' : 'Развернуть углы'}
            </button>
            <button
              className={`btn-unwrap turn-vis-btn${showTurns ? ' active' : ''}`}
              onClick={() => setShowTurns(v => !v)}
              disabled={!hasTurnCol || !chartReady}
              title={
                !hasTurnCol
                  ? 'Нет колонки XData для анализа разворотов'
                  : !chartReady
                    ? 'Сначала постройте график'
                    : totalTurns === 0
                      ? 'Разворотов не обнаружено (≥60° за ≤300 мс)'
                      : showTurns
                        ? 'Скрыть развороты на графике'
                        : `Показать ${totalTurns} разворот(ов): S1 — синий, S2 — оранжевый`
              }
            >
              {showTurns ? '●' : '○'}&nbsp;Показать развороты{totalTurns > 0 ? ` (${totalTurns})` : ''}
            </button>
            <button className="btn-build" disabled={!selectedCols.length} onClick={renderChart}>
              ▶ Построить
            </button>
          </div>
        </div>
      )}

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
                <p>Перетащите видео или используйте кнопку выше</p>
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
            <span className="time-lbl muted">S1:{offsetS1} S2:{offsetS2}{timeUnit === 'ms' ? 'мс' : 'с'}</span>
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
            <button
              className={`lab-mode-btn${labelingMode ? ' active' : ''}`}
              onClick={() => setLabelingMode(m => !m)}
              title={labelingMode ? 'Выключить режим разметки' : 'Включить режим разметки'}
            >
              ✏ {labelingMode ? 'Разметка вкл' : 'Разметка'}
            </button>

            <button
              className={`gap-vis-btn${showGaps ? ' vis-on' : ''}`}
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
              <div className="pattern-toggle">
                <button
                  className={`pattern-vis-btn${showLeftPatterns ? ' vis-on' : ''}`}
                  style={{ '--pc': L_LINE }}
                  onClick={() => setShowLeftPatterns(v => !v)}
                  title={showLeftPatterns ? 'Скрыть паттерны Sensor 1' : 'Показать паттерны Sensor 1'}
                >
                  {showLeftPatterns ? '●' : '○'}&nbsp;S1
                </button>
                <button
                  className={`pattern-vis-btn${showRightPatterns ? ' vis-on' : ''}`}
                  style={{ '--pc': R_LINE }}
                  onClick={() => setShowRightPatterns(v => !v)}
                  title={showRightPatterns ? 'Скрыть паттерны Sensor 2' : 'Показать паттерны Sensor 2'}
                >
                  {showRightPatterns ? '●' : '○'}&nbsp;S2
                </button>
              </div>
            )}

            {labelingMode && (
              <>
                <div className="foot-toggle">
                  <button
                    className={`foot-btn${currentFoot === 'left' ? ' active left-active' : ''}`}
                    onClick={() => setCurrentFoot('left')}
                  >
                    ◀ Sensor 1&nbsp;<span className="foot-count">{leftContacts.length}</span>
                  </button>
                  <button
                    className={`foot-btn${currentFoot === 'right' ? ' active right-active' : ''}`}
                    onClick={() => setCurrentFoot('right')}
                  >
                    Sensor 2&nbsp;<span className="foot-count">{rightContacts.length}</span>&nbsp;▶
                  </button>
                </div>

                <button className="lab-btn" onClick={undoContact} title="Отменить последний клик">↩ Отмена</button>
                <button className="lab-btn danger" onClick={clearCurrentContacts} title="Очистить текущую ногу">Очист.</button>
                <button className="lab-btn danger" onClick={clearAllContacts} title="Очистить всё">Все</button>
                <button
                  className="lab-btn export"
                  onClick={exportLabels}
                  disabled={totalContacts === 0}
                  title="Скачать CSV с разметкой Target"
                >⬇ CSV</button>

                <span className="lab-stat">
                  <span className="lab-stat-l">S1: {Math.floor(leftContacts.length / 2)}</span>
                  {' | '}
                  <span className="lab-stat-r">S2: {Math.floor(rightContacts.length / 2)}</span>
                  {' интерв.'}
                </span>

                {(leftContacts.length > 0 || rightContacts.length > 0) && (
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
                              onClick={() => setSelectedMarkup({ foot, index: i * 2 })}
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
                            onClick={() => setSelectedMarkup({ foot, index: contacts.length - 1 })}
                          >
                            …2-я точка
                          </span>
                        )}
                      </div>
                    ))}
                    <div className="zone-dur-actions">
                      <button
                        className="lab-btn danger"
                        onClick={deleteSelectedMarkup}
                        disabled={!selectedMarkup}
                        title="Удалить выбранный интервал из списка"
                      >
                        ✕ Удалить выбранную
                      </button>
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
                        return (
                          <span className="lab-stat lab-stat-selected">
                            {footLabel} #{intervalNum}
                            {hasPair ? `: ${fmt(t0)} → ${fmt(t1)}` : `: ${fmt(t0)} (1 точка)`}
                          </span>
                        )
                      })()}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="chart-area">
            <div ref={chartDivRef} style={{ width: '100%', height: '100%' }} />
            {!chartReady && (
              <div className="chart-empty">
                {parquetData
                  ? <><span>📊</span><p>Выберите колонки и нажмите <b>▶ Построить</b></p></>
                  : <><span>📊</span><p>Загрузите <b>.parquet</b>-файл или введите номер сессии</p></>
                }
              </div>
            )}
          </div>
        </div>
      </div>

      {dragOver && (
        <div className="drag-overlay">
          <div className="drag-box">⬇<p>Видео или .parquet</p></div>
        </div>
      )}
    </div>
  )
}

function UploadBtn({ accept, onFile, children }) {
  return (
    <label className="btn-upload">
      {children}
      <input type="file" accept={accept} hidden
        onChange={e => e.target.files[0] && onFile(e.target.files[0])} />
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
