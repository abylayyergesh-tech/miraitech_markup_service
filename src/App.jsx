import { useState, useRef, useEffect, useCallback } from 'react'
import Plotly from 'plotly.js-dist-min'
import { parquetReadObjects } from 'hyparquet'
import './App.css'

// ── Constants ──────────────────────────────────────────────────────────────
const API_BASE = 'https://api.miraitech.health'

const PALETTE = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728',
  '#9467bd', '#8c564b', '#e377c2', '#17becf',
]
const NON_DATA_COLS = new Set([
  'Name', 'Time', 'time', 'timestamp', 'Timestamp', 't',
  'target', 'Target', 'label', 'Label',
])
const PREFERRED_COLS = ['AcX', 'AcY', 'AcZ', 'XData', 'YData', 'ZData', 'GravityZ']

const L_FILL = 'rgba(31,119,180,0.35)'
const R_FILL = 'rgba(255,127,14,0.35)'
const L_LINE = 'rgba(31,119,180,0.9)'
const R_LINE = 'rgba(255,127,14,0.9)'

function safeNum(v) {
  if (v === null || v === undefined) return null
  const n = typeof v === 'bigint' ? Number(v) : Number(v)
  return isFinite(n) ? n : null
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

  // Files
  const [videoUrl, setVideoUrl]         = useState(null)
  const [videoName, setVideoName]       = useState('')

  // Data
  const [parquetData, setParquetData]   = useState(null)
  const [columns, setColumns]           = useState([])
  const [sensorNames, setSensorNames]   = useState([])
  const [showSensor1, setShowSensor1]   = useState(true)
  const [showSensor2, setShowSensor2]   = useState(true)
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
  const cursorShapesRef  = useRef([])
  const selectedColsRef  = useRef([])
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
  const s1TraceIdxRef    = useRef([])
  const s2TraceIdxRef    = useRef([])

  useEffect(() => { offsetS1Ref.current    = offsetS1     }, [offsetS1])
  useEffect(() => { offsetS2Ref.current    = offsetS2     }, [offsetS2])
  useEffect(() => { timeUnitRef.current    = timeUnit     }, [timeUnit])
  useEffect(() => { labelingRef.current    = labelingMode }, [labelingMode])
  useEffect(() => { currentFootRef.current = currentFoot  }, [currentFoot])
  useEffect(() => { selectedColsRef.current = selectedCols }, [selectedCols])

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
        throw new Error(errData.detail || `Ошибка ${resp.status}`)
      }
      const data = await resp.json()
      const tok = data.access_token || data.token
      if (!tok) throw new Error('Токен не получен от сервера')
      setToken(tok)
      sessionStorage.setItem('auth_token', tok)
    } catch (err) {
      setLoginError(err.message)
    } finally {
      setAuthLoading(false)
    }
  }, [loginEmail, loginPassword])

  const handleLogout = useCallback(() => {
    setToken('')
    sessionStorage.removeItem('auth_token')
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
    } catch (err) {
      setStatus({ text: `Ошибка: ${err.message}`, type: 'error' })
    }
  }, [token, sessionId])

  // ── Contact shapes ────────────────────────────────────────────────────────
  const updateContactShapes = useCallback(() => {
    if (!chartDivRef.current || !plotInitRef.current) return
    const shapes = []

    const pushShapes = (contacts, fillColor, lineColor) => {
      for (let i = 0; i + 1 < contacts.length; i += 2) {
        const x0 = Math.min(contacts[i], contacts[i + 1])
        const x1 = Math.max(contacts[i], contacts[i + 1])
        shapes.push({
          type: 'rect', x0, x1,
          y0: 0, y1: 1, yref: 'paper',
          fillcolor: fillColor,
          line: { color: lineColor, width: 1.5 },
          layer: 'below',
        })
      }
      if (contacts.length % 2 === 1) {
        const t = contacts[contacts.length - 1]
        shapes.push({
          type: 'line', x0: t, x1: t,
          y0: 0, y1: 1, yref: 'paper',
          line: { color: lineColor, width: 2, dash: 'dot' },
        })
      }
    }

    if (showLeftRef.current)  pushShapes(leftContactsRef.current,  L_FILL, L_LINE)
    if (showRightRef.current) pushShapes(rightContactsRef.current, R_FILL, R_LINE)
    contactShapesRef.current = shapes
    Plotly.relayout(chartDivRef.current, { shapes: [...cursorShapesRef.current, ...shapes] })
  }, [])

  useEffect(() => {
    leftContactsRef.current  = leftContacts
    rightContactsRef.current = rightContacts
    if (plotInitRef.current && chartDivRef.current) updateContactShapes()
  }, [leftContacts, rightContacts, updateContactShapes])

  useEffect(() => {
    showLeftRef.current  = showLeftPatterns
    showRightRef.current = showRightPatterns
    if (plotInitRef.current && chartDivRef.current) updateContactShapes()
  }, [showLeftPatterns, showRightPatterns, updateContactShapes])

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
  }, [])

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

    const data1 = filterBySensor(sensor1Name)
    const data2 = sensor2Name ? filterBySensor(sensor2Name) : null

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
      updateContactShapes()
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
  }, [parquetData, selectedCols, timeCol, sensorNames, offsetS1, offsetS2, updateContactShapes])

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
    Plotly.relayout(chartDivRef.current, { shapes: [...cursorShapesRef.current, ...contactShapesRef.current] })
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
          <input
            type="number"
            className="input-sm session-input"
            value={sessionId}
            onChange={e => setSessionId(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && loadSession()}
            placeholder="3421"
            min="1"
          />
          <button
            className="btn-build"
            onClick={loadSession}
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
                return (
                  <button
                    key={name}
                    className={`sensor-badge${isVisible ? '' : ' sensor-badge-off'}`}
                    style={isVisible ? { borderColor: color, color, background: bg } : {}}
                    onClick={toggle}
                    title={isVisible ? `Скрыть ${name}` : `Показать ${name}`}
                  >
                    {isVisible ? '●' : '○'}&nbsp;{name.replace('ESP32_', '')}&nbsp;{i === 0 ? '(left)' : '(right)'}
                  </button>
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
                      { contacts: leftContacts, cls: 'zone-dur-s1', label: 'S1' },
                      { contacts: rightContacts, cls: 'zone-dur-s2', label: 'S2' },
                    ].map(({ contacts, cls, label }) => contacts.length > 0 && (
                      <div key={label} className="zone-dur-row">
                        <span className={`zone-dur-label ${cls}`}>{label}</span>
                        {Array.from({ length: Math.floor(contacts.length / 2) }, (_, i) => {
                          const t0 = contacts[i * 2]
                          const t1 = contacts[i * 2 + 1]
                          const dur = Math.abs(t1 - t0)
                          return (
                            <span
                              key={i}
                              className={`zone-dur-chip ${cls}`}
                              title={`${t0.toFixed(2)} → ${t1.toFixed(2)}`}
                            >
                              #{i + 1}&thinsp;{formatDuration(dur, timeUnit)}
                            </span>
                          )
                        })}
                        {contacts.length % 2 === 1 && (
                          <span className="zone-dur-chip zone-dur-pending">…2-я точка</span>
                        )}
                      </div>
                    ))}
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
