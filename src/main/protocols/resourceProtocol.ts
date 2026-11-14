import { fileURLToPath } from 'node:url'
let resolver: ((url: string, category?: string) => string) | undefined
export const configureResourceResolver = (value: typeof resolver): void => { resolver = value }
export const resolveAppResourcePath = (url: string, category?: string): string => {
  if (resolver) return resolver(url, category)
  if (url.startsWith('file:')) return fileURLToPath(url)
  if (url.startsWith('app-resource:')) throw new Error('Host must configure a resolver for app-resource URLs.')
  return url
}
