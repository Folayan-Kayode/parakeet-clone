import { lookup } from 'node:dns/promises'
import { BlockList } from 'node:net'

// Pure host/URL guards extracted from main/index.ts. Node-only (net + dns) but
// free of Electron so the string-level logic is unit-testable.

const BLOCKED_IPV6 = new BlockList()
BLOCKED_IPV6.addAddress('::', 'ipv6')
BLOCKED_IPV6.addAddress('::1', 'ipv6')
BLOCKED_IPV6.addSubnet('fe80::', 10, 'ipv6')
BLOCKED_IPV6.addSubnet('fd00::', 8, 'ipv6')

const MAX_JOB_STRIP_INPUT = 150_000

export function normalizeHost(hostname: string): string {
  const host = hostname.toLowerCase()
  return host.endsWith('.') ? host.slice(0, -1) : host
}

// Strict dotted quad only: rejects octal/decimal/shorthand IPv4 literals.
export function parseDottedQuad(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    octets.push(value)
  }
  return octets
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}

// URL parsing canonicalizes IPv6 (compressed + lowercase), which also catches
// mapped addresses written in expanded form.
export function canonicalIpv6(address: string): string {
  const bare = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  try {
    return new URL(`http://[${bare}]/`).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return bare
  }
}

// ::ffff:0:0/96 — compare the embedded low 32 bits against the IPv4 ranges.
export function mappedIpv4(address: string): number[] | null {
  const host = canonicalIpv6(address)
  if (!host.startsWith('::ffff:')) return null
  const tail = host.slice('::ffff:'.length)
  if (tail.includes('.')) return parseDottedQuad(tail)
  const groups = tail.split(':')
  if (groups.length !== 2) return null
  const hi = Number.parseInt(groups[0], 16)
  const lo = Number.parseInt(groups[1], 16)
  if (!Number.isInteger(hi) || !Number.isInteger(lo)) return null
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]
}

export function isBlockedIpv6(address: string): boolean {
  const mapped = mappedIpv4(address)
  if (mapped) return isPrivateIpv4(mapped)
  return BLOCKED_IPV6.check(canonicalIpv6(address), 'ipv6')
}

export function isBlockedHost(hostname: string): boolean {
  const host = normalizeHost(hostname)
  if (host === 'localhost' || host.endsWith('.local')) return true
  if (/^[0-9.]+$/.test(host)) {
    // Anything numeric must be a strict public dotted quad; this blocks
    // 2130706433, 127.1 and 0177.0.0.1 before any resolver sees them.
    const quad = parseDottedQuad(host)
    return quad === null || isPrivateIpv4(quad)
  }
  if (host.includes(':')) return isBlockedIpv6(host)
  return false
}

export async function assertPublicHost(hostname: string): Promise<void> {
  const host = normalizeHost(hostname)
  if (isBlockedHost(host)) throw new Error('Local/private URLs are not supported')
  const lookupHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = await lookup(lookupHost, { all: true })
  } catch {
    throw new Error('Could not resolve host')
  }
  for (const entry of addresses) {
    if (entry.family === 4) {
      const octets = parseDottedQuad(entry.address)
      if (!octets || isPrivateIpv4(octets)) {
        throw new Error('Local/private URLs are not supported')
      }
    } else if (isBlockedIpv6(entry.address)) {
      throw new Error('Local/private URLs are not supported')
    }
  }
}

function decodeCodePoint(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return ''
  if (value >= 0xd800 && value <= 0xdfff) return ''
  return String.fromCodePoint(value)
}

export function decodeHtml(text: string): string {
  // &amp; is decoded last so a literal "&amp;lt;" stays "&lt;".
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      decodeCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_match, dec: string) => decodeCodePoint(Number(dec)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
}

// ASCII-only lowercasing keeps indices aligned with the original string.
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (char) => char.toLowerCase())
}

function isTagNameChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) // a-z
  )
}

// Single-pass tag tokenizer: no regex over the whole document. Script/style
// bodies are skipped wholesale; <title> and og:title are captured separately.
export function stripHtml(html: string): { text: string; title: string } {
  const source = html.slice(0, MAX_JOB_STRIP_INPUT)
  const lower = asciiLower(source)
  let out = ''
  let docTitle = ''
  let ogTitle = ''
  let i = 0

  while (i < source.length) {
    const lt = source.indexOf('<', i)
    if (lt < 0) {
      out += source.slice(i)
      break
    }
    out += source.slice(i, lt)

    if (lower.startsWith('<!--', lt)) {
      const end = lower.indexOf('-->', lt + 4)
      if (end < 0) break
      out += ' '
      i = end + 3
      continue
    }

    const gt = source.indexOf('>', lt + 1)
    if (gt < 0) break

    let p = lt + 1
    const closing = source[p] === '/'
    if (closing) p++
    const nameStart = p
    while (p < source.length && isTagNameChar(source.charCodeAt(p))) p++
    const name = lower.slice(nameStart, p)

    if (!closing && (name === 'script' || name === 'style')) {
      const close = lower.indexOf(`</${name}`, gt + 1)
      if (close < 0) break
      const closeGt = source.indexOf('>', close)
      if (closeGt < 0) break
      out += ' '
      i = closeGt + 1
      continue
    }

    if (!closing && name === 'title') {
      const close = lower.indexOf('</title', gt + 1)
      if (close < 0) {
        i = gt + 1
        continue
      }
      if (!docTitle) docTitle = source.slice(gt + 1, close)
      const closeGt = source.indexOf('>', close)
      if (closeGt < 0) break
      out += ' '
      i = closeGt + 1
      continue
    }

    if (!closing && name === 'meta' && !ogTitle) {
      const tag = source.slice(lt, gt + 1)
      if (/(?:property|name)\s*=\s*["']?og:title\b/i.test(tag)) {
        const content = /(?:^|\s)content\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag)
        ogTitle = content?.[2] ?? content?.[3] ?? content?.[4] ?? ''
      }
    }

    out += ' '
    i = gt + 1
  }

  return {
    title: decodeHtml((ogTitle || docTitle).replace(/\s+/g, ' ').trim()).slice(0, 200),
    text: decodeHtml(out).replace(/\s+/g, ' ').trim()
  }
}
