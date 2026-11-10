// Unit-тесты для модуля архивов (Bun.Archive API)
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { join } from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import {
  extractTarGz,
  extractTarGzToDir,
  extractFileFromTarGz,
  createTarGz,
  createTarGzFromDir,
  preserveFiles,
  restoreFiles,
  computeSha256,
  computeFileSha256,
  type TarEntry,
} from '../../src/update/archive'

// ─────────────────────────────────────────────────────────────────────────────
// Утилиты для тестов
// ─────────────────────────────────────────────────────────────────────────────

const TEST_DIR = join(import.meta.dir, '.tmp-archive-test')
const encoder = new TextEncoder()

/** Создаёт тестовый tar.gz архив из набора файлов */
async function createTestArchive(files: Record<string, string>): Promise<Uint8Array> {
  const entries: TarEntry[] = Object.entries(files).map(([name, content]) => ({
    name,
    data: encoder.encode(content),
    type: '0',
  }))
  return createTarGz(entries)
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup / Teardown
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true })
})

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// createTarGz
// ─────────────────────────────────────────────────────────────────────────────

describe('createTarGz', () => {
  test('создаёт непустой архив из записей', async () => {
    const entries: TarEntry[] = [
      { name: 'hello.txt', data: encoder.encode('Hello'), type: '0' },
    ]
    const archive = await createTarGz(entries)

    expect(archive).toBeInstanceOf(Uint8Array)
    expect(archive.length).toBeGreaterThan(0)
  })

  test('создаёт архив из нескольких файлов', async () => {
    const entries: TarEntry[] = [
      { name: 'a.txt', data: encoder.encode('AAA'), type: '0' },
      { name: 'b.txt', data: encoder.encode('BBB'), type: '0' },
      { name: 'sub/c.txt', data: encoder.encode('CCC'), type: '0' },
    ]
    const archive = await createTarGz(entries)

    expect(archive.length).toBeGreaterThan(0)
  })

  test('пропускает записи без данных', async () => {
    const entries: TarEntry[] = [
      { name: 'empty', type: '5' }, // директория без данных
      { name: 'file.txt', data: encoder.encode('content'), type: '0' },
    ]
    const archive = await createTarGz(entries)

    expect(archive.length).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// extractTarGz
// ─────────────────────────────────────────────────────────────────────────────

describe('extractTarGz', () => {
  test('распаковывает архив в массив записей', async () => {
    const original = { 'hello.txt': 'Hello, World!' }
    const archive = await createTestArchive(original)

    const entries = await extractTarGz(archive)

    expect(entries.length).toBe(1)
    expect(entries[0].name).toBe('hello.txt')
    expect(entries[0].data).toBeDefined()

    const text = new TextDecoder().decode(entries[0].data!)
    expect(text).toBe('Hello, World!')
  })

  test('распаковывает архив с несколькими файлами', async () => {
    const original = {
      'a.txt': 'AAA',
      'b.txt': 'BBB',
      'nested/c.txt': 'CCC',
    }
    const archive = await createTestArchive(original)

    const entries = await extractTarGz(archive)

    expect(entries.length).toBe(3)

    const names = entries.map((e) => e.name).sort()
    expect(names).toEqual(['a.txt', 'b.txt', 'nested/c.txt'])
  })

  test('сохраняет содержимое файлов', async () => {
    const original = {
      'data.json': JSON.stringify({ key: 'value' }),
    }
    const archive = await createTestArchive(original)

    const entries = await extractTarGz(archive)
    const content = JSON.parse(new TextDecoder().decode(entries[0].data!))

    expect(content).toEqual({ key: 'value' })
  })

  test('обрабатывает бинарные данные', async () => {
    const binaryData = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd])
    const entries: TarEntry[] = [
      { name: 'binary.bin', data: binaryData, type: '0' },
    ]
    const archive = await createTarGz(entries)

    const extracted = await extractTarGz(archive)

    expect(extracted.length).toBe(1)
    expect(extracted[0].data).toEqual(binaryData)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// extractTarGzToDir
// ─────────────────────────────────────────────────────────────────────────────

describe('extractTarGzToDir', () => {
  test('распаковывает файлы в директорию', async () => {
    const archive = await createTestArchive({
      'file.txt': 'content',
    })

    const outDir = join(TEST_DIR, 'extract')
    await extractTarGzToDir(archive, outDir)

    const file = Bun.file(join(outDir, 'file.txt'))
    expect(await file.exists()).toBe(true)
    expect(await file.text()).toBe('content')
  })

  test('создаёт вложенные директории', async () => {
    const archive = await createTestArchive({
      'a/b/c/deep.txt': 'deep content',
    })

    const outDir = join(TEST_DIR, 'nested')
    await extractTarGzToDir(archive, outDir)

    const file = Bun.file(join(outDir, 'a/b/c/deep.txt'))
    expect(await file.exists()).toBe(true)
    expect(await file.text()).toBe('deep content')
  })

  test('отклоняет путь, выходящий за целевую директорию', async () => {
    const archive = await createTestArchive({
      '../escape.txt': 'must not be written',
    })

    await expect(extractTarGzToDir(archive, join(TEST_DIR, 'safe'))).rejects.toThrow()
    expect(await Bun.file(join(TEST_DIR, 'escape.txt')).exists()).toBe(false)
  })

  test('распаковывает несколько файлов', async () => {
    const archive = await createTestArchive({
      'one.txt': '1',
      'two.txt': '2',
      'sub/three.txt': '3',
    })

    const outDir = join(TEST_DIR, 'multi')
    await extractTarGzToDir(archive, outDir)

    expect(await Bun.file(join(outDir, 'one.txt')).text()).toBe('1')
    expect(await Bun.file(join(outDir, 'two.txt')).text()).toBe('2')
    expect(await Bun.file(join(outDir, 'sub/three.txt')).text()).toBe('3')
  })

  test('вызывает onProgress для каждого файла', async () => {
    const archive = await createTestArchive({
      'a.txt': 'A',
      'b.txt': 'B',
      'c.txt': 'C',
    })

    const outDir = join(TEST_DIR, 'progress')
    const progress: Array<{ current: number; total: number; fileName: string }> = []

    await extractTarGzToDir(archive, outDir, (p) => progress.push({ ...p }))

    expect(progress.length).toBe(3)
    expect(progress[0].current).toBe(1)
    expect(progress[0].total).toBe(3)
    expect(progress[2].current).toBe(3)
    expect(progress[2].total).toBe(3)
  })

  test('работает без onProgress (быстрый путь)', async () => {
    const archive = await createTestArchive({ 'fast.txt': 'fast' })

    const outDir = join(TEST_DIR, 'fast')
    await extractTarGzToDir(archive, outDir)

    expect(await Bun.file(join(outDir, 'fast.txt')).text()).toBe('fast')
  })

  test('распаковывает архив с диска и отклоняет путь за пределами', async () => {
    const archive = await createTestArchive({
      'ok.txt': 'ok',
      '../escape.txt': 'must not be written',
    })
    const archivePath = join(TEST_DIR, 'from-disk.tar.gz')
    await Bun.write(archivePath, archive)

    await expect(extractTarGzToDir(archivePath, join(TEST_DIR, 'safe-disk'))).rejects.toThrow()
    expect(await Bun.file(join(TEST_DIR, 'escape.txt')).exists()).toBe(false)

    const okArchive = await createTestArchive({ 'ok.txt': 'ok' })
    await Bun.write(archivePath, okArchive)
    await extractTarGzToDir(archivePath, join(TEST_DIR, 'from-disk'))
    expect(await Bun.file(join(TEST_DIR, 'from-disk', 'ok.txt')).text()).toBe('ok')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// extractFileFromTarGz
// ─────────────────────────────────────────────────────────────────────────────

describe('extractFileFromTarGz', () => {
  test('извлекает файл по точному имени', async () => {
    const archive = await createTestArchive({
      'target.txt': 'found it',
      'other.txt': 'not this',
    })

    const data = await extractFileFromTarGz(archive, 'target.txt')

    expect(data).not.toBeNull()
    expect(new TextDecoder().decode(data!)).toBe('found it')
  })

  test('извлекает файл из вложенного пути', async () => {
    const archive = await createTestArchive({
      'path/to/binary': 'binary content',
    })

    expect(await extractFileFromTarGz(archive, 'binary')).toBeNull()
    const data = await extractFileFromTarGz(archive, 'path/to/binary')
    expect(new TextDecoder().decode(data!)).toBe('binary content')
  })

  test('возвращает null если файл не найден', async () => {
    const archive = await createTestArchive({
      'existing.txt': 'exists',
    })

    const data = await extractFileFromTarGz(archive, 'missing.txt')

    expect(data).toBeNull()
  })

  test('находит файл в корне архива', async () => {
    const archive = await createTestArchive({
      'service-manager': 'binary data',
    })

    const data = await extractFileFromTarGz(archive, 'service-manager')

    expect(data).not.toBeNull()
    expect(new TextDecoder().decode(data!)).toBe('binary data')
  })

  test('извлекает файл по пути к архиву на диске', async () => {
    const archive = await createTestArchive({
      'from-disk.txt': 'disk',
    })
    const archivePath = join(TEST_DIR, 'extract-file.tar.gz')
    await Bun.write(archivePath, archive)

    const data = await extractFileFromTarGz(archivePath, 'from-disk.txt')

    expect(data).not.toBeNull()
    expect(new TextDecoder().decode(data!)).toBe('disk')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// createTarGzFromDir
// ─────────────────────────────────────────────────────────────────────────────

describe('createTarGzFromDir', () => {
  test('создаёт архив из директории', async () => {
    const srcDir = join(TEST_DIR, 'src')
    await mkdir(srcDir, { recursive: true })
    await Bun.write(join(srcDir, 'file1.txt'), 'content1')
    await Bun.write(join(srcDir, 'file2.txt'), 'content2')

    const archive = await createTarGzFromDir(srcDir)

    expect(archive.length).toBeGreaterThan(0)

    // Проверяем содержимое через распаковку
    const entries = await extractTarGz(archive)
    const names = entries.map((e) => e.name).sort()
    expect(names).toEqual(['file1.txt', 'file2.txt'])
  })

  test('создаёт архив с вложенными директориями', async () => {
    const srcDir = join(TEST_DIR, 'nested-src')
    await mkdir(join(srcDir, 'sub'), { recursive: true })
    await Bun.write(join(srcDir, 'root.txt'), 'root')
    await Bun.write(join(srcDir, 'sub/nested.txt'), 'nested')

    const archive = await createTarGzFromDir(srcDir)
    const entries = await extractTarGz(archive)
    const names = entries.map((e) => e.name).sort()

    expect(names).toContain('root.txt')
    expect(names).toContain('sub/nested.txt')
  })

  test('исключает файлы по паттернам', async () => {
    const srcDir = join(TEST_DIR, 'exclude')
    await mkdir(srcDir, { recursive: true })
    await Bun.write(join(srcDir, 'keep.txt'), 'keep')
    await Bun.write(join(srcDir, '.env'), 'secret')
    await Bun.write(join(srcDir, 'debug.log'), 'log')

    const archive = await createTarGzFromDir(srcDir, ['.env', '.log'])
    const entries = await extractTarGz(archive)
    const names = entries.map((e) => e.name)

    expect(names).toContain('keep.txt')
    expect(names).not.toContain('.env')
    expect(names).not.toContain('debug.log')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Roundtrip: создание → распаковка
// ─────────────────────────────────────────────────────────────────────────────

describe('Roundtrip', () => {
  test('создание и распаковка сохраняют содержимое', async () => {
    const original: Record<string, string> = {
      'readme.md': '# Hello',
      'src/index.ts': 'console.log("hello")',
      'config/settings.json': '{"key": "value"}',
    }

    const archive = await createTestArchive(original)
    const entries = await extractTarGz(archive)

    for (const entry of entries) {
      const expectedContent = original[entry.name]
      const actualContent = new TextDecoder().decode(entry.data!)
      expect(actualContent).toBe(expectedContent)
    }
  })

  test('создание из директории и распаковка в другую', async () => {
    // Создаём исходную директорию
    const srcDir = join(TEST_DIR, 'roundtrip-src')
    await mkdir(join(srcDir, 'sub'), { recursive: true })
    await Bun.write(join(srcDir, 'a.txt'), 'AAA')
    await Bun.write(join(srcDir, 'sub/b.txt'), 'BBB')

    // Архивируем
    const archive = await createTarGzFromDir(srcDir)

    // Распаковываем в другую директорию
    const outDir = join(TEST_DIR, 'roundtrip-out')
    await extractTarGzToDir(archive, outDir)

    // Проверяем
    expect(await Bun.file(join(outDir, 'a.txt')).text()).toBe('AAA')
    expect(await Bun.file(join(outDir, 'sub/b.txt')).text()).toBe('BBB')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// preserveFiles / restoreFiles
// ─────────────────────────────────────────────────────────────────────────────

describe('preserveFiles / restoreFiles', () => {
  test('сохраняет и восстанавливает файлы', async () => {
    const baseDir = join(TEST_DIR, 'preserve')
    await mkdir(baseDir, { recursive: true })
    await Bun.write(join(baseDir, '.env'), 'SECRET=123')
    await Bun.write(join(baseDir, 'config.json'), '{"port": 3000}')

    // Сохраняем
    const preserved = await preserveFiles(baseDir, ['.env', 'config.json'])
    expect(preserved.size).toBe(2)

    // Удаляем оригиналы
    await rm(baseDir, { recursive: true })
    await mkdir(baseDir, { recursive: true })

    // Восстанавливаем
    await restoreFiles(baseDir, preserved)

    expect(await Bun.file(join(baseDir, '.env')).text()).toBe('SECRET=123')
    expect(await Bun.file(join(baseDir, 'config.json')).text()).toBe('{"port": 3000}')
  })

  test('пропускает несуществующие файлы при сохранении', async () => {
    const baseDir = join(TEST_DIR, 'preserve-missing')
    await mkdir(baseDir, { recursive: true })
    await Bun.write(join(baseDir, 'exists.txt'), 'here')

    const preserved = await preserveFiles(baseDir, ['exists.txt', 'missing.txt'])

    expect(preserved.size).toBe(1)
    expect(preserved.has('exists.txt')).toBe(true)
    expect(preserved.has('missing.txt')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// computeSha256 / computeFileSha256
// ─────────────────────────────────────────────────────────────────────────────

describe('computeSha256', () => {
  test('вычисляет SHA256 для данных', () => {
    const data = encoder.encode('hello')
    const hash = computeSha256(data)

    // SHA256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })

  test('возвращает hex-строку длиной 64', () => {
    const hash = computeSha256(encoder.encode('test'))
    expect(hash.length).toBe(64)
    expect(hash).toMatch(/^[0-9a-f]+$/)
  })

  test('одинаковые данные дают одинаковый хэш', () => {
    const data = encoder.encode('same content')
    expect(computeSha256(data)).toBe(computeSha256(data))
  })

  test('разные данные дают разный хэш', () => {
    const hash1 = computeSha256(encoder.encode('data1'))
    const hash2 = computeSha256(encoder.encode('data2'))
    expect(hash1).not.toBe(hash2)
  })
})

describe('computeFileSha256', () => {
  test('вычисляет SHA256 файла', async () => {
    const filePath = join(TEST_DIR, 'hash-test.txt')
    await Bun.write(filePath, 'hello')

    const hash = await computeFileSha256(filePath)

    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })

  test('совпадает с computeSha256 для тех же данных', async () => {
    const content = 'test content for hash comparison'
    const filePath = join(TEST_DIR, 'hash-compare.txt')
    await Bun.write(filePath, content)

    const fileHash = await computeFileSha256(filePath)
    const dataHash = computeSha256(encoder.encode(content))

    expect(fileHash).toBe(dataHash)
  })
})
