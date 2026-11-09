export {}

declare global {
  interface Window {
    api: import('../../preload/index').Api
    __pcAutostart?: () => void
  }
}
