export function backstop(ms: number, expire: () => void): () => void {
  const timer = setTimeout(expire, ms)
  timer.unref()
  return () => clearTimeout(timer)
}
