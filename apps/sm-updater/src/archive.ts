// Модуль для работы с tar.gz архивами
// Использует нативный Bun.Archive API (Bun 1.3.6+)

// ─────────────────────────────────────────────────────────────────────────────
// Типы
// ─────────────────────────────────────────────────────────────────────────────

export interface TarEntry {
  name: string
  data?: Uint8Array
  mode?: number
  type?: string // '0' = file, '5' = directory
}

// ─────────────────────────────────────────────────────────────────────────────
// Создание архивов
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Создаёт tar.gz архив из массива файлов
 * Использует нативный Bun.Archive API
 */
export async function createTarGz(files: TarEntry[]): Promise<Uint8Array> {
  const filesObj: Record<string, Uint8Array> = {}

  for (const entry of files) {
    if (entry.data) {
      filesObj[entry.name] = entry.data
    }
  }

  const archive = new Bun.Archive(filesObj, { compress: 'gzip' })
  return archive.bytes()
}

/**
 * Создаёт tar.gz архив из одного файла
 */
export async function createSingleFileTarGz(
  fileName: string,
  data: Uint8Array,
  mode: number = 0o755,
): Promise<Uint8Array> {
  return createTarGz([
    {
      name: fileName,
      data,
      mode,
      type: '0',
    },
  ])
}

/**
 * Дополнительный файл для добавления в архив
 */
export interface ExtraFile {
  name: string
  content: string | Uint8Array
  mode?: number
}

/**
 * Создаёт tar.gz архив из директории
 * @param dirPath - путь к директории
 * @param excludePatterns - паттерны для исключения (например ['.env'])
 * @param extraFiles - дополнительные файлы для добавления в архив
 * @returns архив и общий размер файлов
 */
export async function createDirTarGz(
  dirPath: string,
  excludePatterns: string[] = [],
  extraFiles: ExtraFile[] = [],
): Promise<{ archive: Uint8Array; totalSize: number }> {
  const filesObj: Record<string, Uint8Array> = {}
  let totalSize = 0

  const glob = new Bun.Glob('**/*')

  for await (const relativePath of glob.scan({ cwd: dirPath, dot: true })) {
    // Проверяем исключения
    const shouldExclude = excludePatterns.some((pattern) => {
      if (pattern.startsWith('*')) {
        // Glob паттерн типа *.log
        return relativePath.endsWith(pattern.slice(1))
      }
      return relativePath === pattern || relativePath.startsWith(pattern + '/')
    })

    if (shouldExclude) continue

    const fullPath = `${dirPath}/${relativePath}`
    const file = Bun.file(fullPath)

    // Проверяем что это файл
    const exists = await file.exists()
    if (!exists) continue

    const stat = await file.stat()
    if (!stat || stat.isDirectory()) continue

    const data = await file.arrayBuffer()
    totalSize += data.byteLength

    filesObj[relativePath.replace(/\\/g, '/')] = new Uint8Array(data)
  }

  // Добавляем дополнительные файлы
  for (const extra of extraFiles) {
    const data = typeof extra.content === 'string' ? new TextEncoder().encode(extra.content) : extra.content
    totalSize += data.byteLength
    filesObj[extra.name] = data instanceof Uint8Array ? data : new Uint8Array(data)
  }

  const bunArchive = new Bun.Archive(filesObj, { compress: 'gzip' })
  const archive = await bunArchive.bytes()
  return { archive, totalSize }
}

/**
 * Создаёт tar.gz архив из бинарника + выбранных папок
 * @param dirPath - путь к директории dist
 * @param binaryName - имя бинарника
 * @param includeDirs - папки для включения (например ['docker/'])
 * @param excludePatterns - паттерны для исключения внутри includeDirs
 * @returns архив и общий размер файлов
 */
export async function createSelectiveTarGz(
  dirPath: string,
  binaryName: string,
  includeDirs: string[],
  excludePatterns: string[] = [],
): Promise<{ archive: Uint8Array; totalSize: number }> {
  const filesObj: Record<string, Uint8Array> = {}
  let totalSize = 0

  // 1. Добавляем бинарник
  const binaryPath = `${dirPath}/${binaryName}`
  const binaryFile = Bun.file(binaryPath)

  if (await binaryFile.exists()) {
    const data = await binaryFile.arrayBuffer()
    totalSize += data.byteLength
    filesObj[binaryName] = new Uint8Array(data)
  }

  // 2. Добавляем файлы из указанных папок
  for (const includeDir of includeDirs) {
    const fullIncludeDir = `${dirPath}/${includeDir}`
    const glob = new Bun.Glob('**/*')

    for await (const relativePath of glob.scan({ cwd: fullIncludeDir, dot: true })) {
      const archivePath = `${includeDir}${relativePath}`.replace(/\\/g, '/')

      // Проверяем исключения
      const shouldExclude = excludePatterns.some((pattern) => {
        if (pattern.startsWith('*')) {
          return relativePath.endsWith(pattern.slice(1))
        }
        return archivePath === pattern || archivePath.startsWith(pattern + '/') || archivePath.startsWith(pattern)
      })

      if (shouldExclude) continue

      const fullPath = `${fullIncludeDir}/${relativePath}`
      const file = Bun.file(fullPath)

      const exists = await file.exists()
      if (!exists) continue

      const stat = await file.stat()
      if (!stat || stat.isDirectory()) continue

      const data = await file.arrayBuffer()
      totalSize += data.byteLength

      filesObj[archivePath] = new Uint8Array(data)
    }
  }

  const bunArchive = new Bun.Archive(filesObj, { compress: 'gzip' })
  const archive = await bunArchive.bytes()
  return { archive, totalSize }
}

// ─────────────────────────────────────────────────────────────────────────────
// Распаковка архивов
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Распаковывает tar.gz данные в массив записей
 * Использует нативный Bun.Archive API
 */
export async function extractTarGz(compressedData: Uint8Array): Promise<TarEntry[]> {
  const archive = new Bun.Archive(compressedData)
  const files = await archive.files()
  const entries: TarEntry[] = []

  for (const [name, file] of files) {
    const data = new Uint8Array(await file.arrayBuffer())
    entries.push({ name, data, type: '0' })
  }

  return entries
}

// ─────────────────────────────────────────────────────────────────────────────
// Утилиты хеширования (нативный Bun API)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Вычисляет SHA256 хэш данных
 * Использует нативный Bun.CryptoHasher
 */
export function computeSha256(data: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(data)
  return hasher.digest('hex')
}

/**
 * Вычисляет SHA256 хэш файла
 */
export async function computeFileSha256(filePath: string): Promise<string> {
  const file = Bun.file(filePath)
  const data = await file.arrayBuffer()
  return computeSha256(new Uint8Array(data))
}
