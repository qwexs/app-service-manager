// Все метаданные удаляются под lock. При ошибке владелец остаётся для ручной проверки.
export interface ShutdownResources {
  stopMonitoring(): void
  stopServices(): Promise<void>
  stopIPC(): Promise<void>
  closeLogger(): Promise<void>
  cleanup(): Promise<void>
  releaseLock(): Promise<void>
}

export function createShutdown(resources: ShutdownResources): () => Promise<void> {
  let pending: Promise<void> | undefined
  return () => pending ??= (async () => {
    resources.stopMonitoring()
    await resources.stopServices()
    await resources.stopIPC()
    await resources.closeLogger()
    await resources.cleanup()
    await resources.releaseLock()
  })()
}
