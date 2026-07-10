import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import process from 'node:process'

const CALCULATOR_HOST = '127.0.0.1'
const CALCULATOR_PORT = 5174

function isCalculatorApiRunning() {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: CALCULATOR_HOST, port: CALCULATOR_PORT })
    const finish = running => {
      socket.destroy()
      resolve(running)
    }
    socket.setTimeout(250)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

function calculatorApiPlugin() {
  let calculatorProcess = null
  let stopping = false

  return {
    name: 'mirai-calculator-api',
    apply: 'serve',
    async configureServer(server) {
      if (await isCalculatorApiRunning()) {
        server.config.logger.info('Calculator API already running on http://127.0.0.1:5174')
        return
      }

      const markupRoot = fileURLToPath(new URL('.', import.meta.url))
      const backendRoot = fileURLToPath(new URL('../MiraiTech-backend/', import.meta.url))
      calculatorProcess = spawn(
        'poetry',
        [
          'run', 'uvicorn', 'calculator_api:app',
          '--app-dir', markupRoot,
          '--host', CALCULATOR_HOST,
          '--port', String(CALCULATOR_PORT),
        ],
        {
          cwd: backendRoot,
          env: { ...process.env, DEBUG: 'false' },
          stdio: 'inherit',
        },
      )

      calculatorProcess.once('error', error => {
        server.config.logger.error(`Could not start calculator API: ${error.message}`)
      })
      calculatorProcess.once('exit', (code, signal) => {
        if (!stopping && code !== 0) {
          server.config.logger.warn(`Calculator API stopped (code ${code}, signal ${signal || 'none'})`)
        }
        calculatorProcess = null
      })

      const stopCalculator = () => {
        stopping = true
        if (calculatorProcess && !calculatorProcess.killed) calculatorProcess.kill('SIGTERM')
      }
      server.httpServer?.once('close', stopCalculator)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), calculatorApiPlugin()],
  server: {
    proxy: {
      '/calculator-api': {
        target: `http://${CALCULATOR_HOST}:${CALCULATOR_PORT}`,
        changeOrigin: true,
        rewrite: path => path.replace(/^\/calculator-api/, ''),
      },
      '/api': {
        target: process.env.VITE_API_PROXY || 'https://dev-api.miraitech.health',
        changeOrigin: true,
      },
    },
  },
})
