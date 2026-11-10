// Простой логгер с цветным выводом и префиксами сервисов

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
}

// Цвета для разных сервисов
const serviceColors: Record<string, string> = {
  app: colors.cyan,
  'worker': colors.magenta,
  database: colors.blue,
  storage: colors.yellow,
  caddy: colors.green,
  manager: colors.white,
}

function getServiceColor(serviceName: string): string {
  return serviceColors[serviceName] || colors.white
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23)
}

function formatPrefix(service: string): string {
  const color = getServiceColor(service)
  const paddedName = service.padEnd(10)
  return `${colors.gray}[${timestamp()}]${colors.reset} ${color}${paddedName}${colors.reset}`
}

export const logger = {
  info(service: string, message: string): void {
    console.log(`${formatPrefix(service)} ${message}`)
  },

  success(service: string, message: string): void {
    console.log(`${formatPrefix(service)} ${colors.green}✓${colors.reset} ${message}`)
  },

  error(service: string, message: string): void {
    console.error(`${formatPrefix(service)} ${colors.red}✗${colors.reset} ${message}`)
  },

  warn(service: string, message: string): void {
    console.warn(`${formatPrefix(service)} ${colors.yellow}⚠${colors.reset} ${message}`)
  },

  debug(service: string, message: string): void {
    if (process.env.DEBUG) {
      console.log(`${formatPrefix(service)} ${colors.dim}${message}${colors.reset}`)
    }
  },

  // Вывод stdout/stderr от сервиса
  stdout(service: string, data: string): void {
    const lines = data.trim().split('\n')
    for (const line of lines) {
      if (line.trim()) {
        console.log(`${formatPrefix(service)} ${colors.dim}│${colors.reset} ${line}`)
      }
    }
  },

  stderr(service: string, data: string): void {
    const lines = data.trim().split('\n')
    for (const line of lines) {
      if (line.trim()) {
        console.error(`${formatPrefix(service)} ${colors.red}│${colors.reset} ${line}`)
      }
    }
  },

  // Разделитель
  separator(): void {
    console.log(`${colors.gray}${'─'.repeat(60)}${colors.reset}`)
  },

  // Заголовок
  header(title: string): void {
    console.log()
    console.log(`${colors.bright}${title}${colors.reset}`)
    this.separator()
  },
}
