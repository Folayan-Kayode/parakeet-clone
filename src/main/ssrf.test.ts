import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertPublicHost,
  canonicalIpv6,
  decodeHtml,
  isBlockedHost,
  isBlockedIpv6,
  mappedIpv4,
  normalizeHost,
  parseDottedQuad,
  stripHtml
} from './ssrf'

// Controllable resolver for the DNS-side SSRF tests. Hoisted so the module mock
// is registered before ./ssrf imports node:dns/promises.
const lookupMock = vi.hoisted(() =>
  vi.fn<
    (
      host: string,
      options: { all: true }
    ) => Promise<Array<{ address: string; family: number }>>
  >()
)
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }))

const BLOCKED_ERROR = 'Local/private URLs are not supported'

describe('normalizeHost', () => {
  it('lowercases and strips one trailing dot', () => {
    expect(normalizeHost('Example.COM.')).toBe('example.com')
    expect(normalizeHost('example.com')).toBe('example.com')
  })
})

describe('parseDottedQuad', () => {
  it('accepts only strict dotted quads', () => {
    expect(parseDottedQuad('1.2.3.4')).toEqual([1, 2, 3, 4])
    expect(parseDottedQuad('255.255.255.255')).toEqual([255, 255, 255, 255])
    expect(parseDottedQuad('0.0.0.0')).toEqual([0, 0, 0, 0])
  })

  it('rejects shorthand, octal, decimal, out-of-range and non-numeric forms', () => {
    expect(parseDottedQuad('127.1')).toBeNull()
    expect(parseDottedQuad('2130706433')).toBeNull()
    expect(parseDottedQuad('0177.0.0.1')).toBeNull()
    expect(parseDottedQuad('01.2.3.4')).toBeNull()
    expect(parseDottedQuad('256.0.0.1')).toBeNull()
    expect(parseDottedQuad('1.2.3')).toBeNull()
    expect(parseDottedQuad('1.2.3.4.5')).toBeNull()
    expect(parseDottedQuad('1.2.3.a')).toBeNull()
    expect(parseDottedQuad('')).toBeNull()
  })
})

describe('isBlockedHost', () => {
  // Review-documented table: numeric literals are rejected before DNS.
  const blocked = [
    '2130706433',
    '127.1',
    '0177.0.0.1',
    'localhost',
    'localhost.',
    'LOCALHOST',
    'foo.local',
    '127.0.0.1',
    '127.0.0.1.',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.1.1',
    '0.0.0.0',
    '::',
    '::1',
    '[::1]',
    'fe80::1',
    'fd00::1',
    '[::ffff:127.0.0.1]',
    '::ffff:192.168.1.1'
  ]

  it.each(blocked)('blocks %s', (host) => {
    expect(isBlockedHost(host)).toBe(true)
  })

  const allowed = [
    'example.com',
    'example.com.',
    'sub.example.com',
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '172.15.0.1',
    '2001:4860:4860::8888',
    // String-level pass: nip.io resolves to 192.168.1.1, so only the DNS step in
    // assertPublicHost catches this. The DNS gap is intentional and untested here.
    '192-168-1-1.nip.io'
  ]

  it.each(allowed)('allows %s at the string level', (host) => {
    expect(isBlockedHost(host)).toBe(false)
  })
})

describe('canonicalIpv6', () => {
  it('compresses and lowercases addresses', () => {
    expect(canonicalIpv6('2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1')
    expect(canonicalIpv6('FE80::1')).toBe('fe80::1')
  })

  it('strips brackets and zone ids', () => {
    expect(canonicalIpv6('[::1]')).toBe('::1')
    expect(canonicalIpv6('fe80::1%eth0')).toBe('fe80::1')
  })

  it('rewrites an embedded dotted quad as hex groups', () => {
    expect(canonicalIpv6('[::FFFF:127.0.0.1]')).toBe('::ffff:7f00:1')
  })

  it('falls back to the bare lowercased string for garbage', () => {
    expect(canonicalIpv6('not-an-ip')).toBe('not-an-ip')
  })
})

describe('mappedIpv4', () => {
  it('extracts the low 32 bits of ::ffff:0:0/96', () => {
    expect(mappedIpv4('[::ffff:127.0.0.1]')).toEqual([127, 0, 0, 1])
    expect(mappedIpv4('::ffff:7f00:1')).toEqual([127, 0, 0, 1])
    expect(mappedIpv4('::ffff:0:0')).toEqual([0, 0, 0, 0])
  })

  it('returns null for non-mapped addresses', () => {
    expect(mappedIpv4('::1')).toBeNull()
    expect(mappedIpv4('2001:db8::1')).toBeNull()
    expect(mappedIpv4('127.0.0.1')).toBeNull()
  })
})

describe('isBlockedIpv6', () => {
  it('blocks loopback, link-local, unique-local and private mapped addresses', () => {
    expect(isBlockedIpv6('::1')).toBe(true)
    expect(isBlockedIpv6('fe80::abcd')).toBe(true)
    expect(isBlockedIpv6('fd12::1')).toBe(true)
    expect(isBlockedIpv6('::ffff:192.168.0.1')).toBe(true)
  })

  it('allows public addresses', () => {
    expect(isBlockedIpv6('2001:4860:4860::8888')).toBe(false)
  })
})

describe('assertPublicHost', () => {
  it.each(['localhost', 'localhost.', '127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', '[::1]'])(
    'rejects %s without a DNS lookup',
    async (host) => {
      await expect(assertPublicHost(host)).rejects.toThrow(BLOCKED_ERROR)
    }
  )
})

describe('assertPublicHost (resolver side)', () => {
  beforeEach(() => {
    lookupMock.mockReset()
  })

  it('rejects a benign-looking host resolving to a private IPv4', async () => {
    lookupMock.mockResolvedValue([{ address: '192.168.1.1', family: 4 }])
    await expect(assertPublicHost('evil.example')).rejects.toThrow(BLOCKED_ERROR)
    expect(lookupMock).toHaveBeenCalledWith('evil.example', { all: true })
  })

  it('allows a host resolving only to a public IPv4', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    await expect(assertPublicHost('good.example')).resolves.toBeUndefined()
  })

  it('rejects when any address in a multi-address answer is private', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 }
    ])
    await expect(assertPublicHost('mixed.example')).rejects.toThrow(BLOCKED_ERROR)
  })

  it('rejects IPv4-mapped loopback returned by the resolver', async () => {
    lookupMock.mockResolvedValue([{ address: '::ffff:127.0.0.1', family: 6 }])
    await expect(assertPublicHost('mapped.example')).rejects.toThrow(BLOCKED_ERROR)
  })

  it('rejects loopback, link-local and ULA IPv6 answers', async () => {
    for (const address of ['::1', 'fe80::1', 'fd00::1']) {
      lookupMock.mockResolvedValue([{ address, family: 6 }])
      await expect(assertPublicHost('v6.example')).rejects.toThrow(BLOCKED_ERROR)
    }
  })

  it('allows a host resolving only to a public IPv6 address', async () => {
    lookupMock.mockResolvedValue([{ address: '2001:4860:4860::8888', family: 6 }])
    await expect(assertPublicHost('v6.good.example')).resolves.toBeUndefined()
  })

  it('reports resolver failures as an unresolved host', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'))
    await expect(assertPublicHost('missing.example')).rejects.toThrow('Could not resolve host')
  })
})

describe('decodeHtml', () => {
  it('decodes named entities', () => {
    expect(decodeHtml('&lt;p&gt; &quot;x&quot; &apos;y&apos; &amp; &nbsp;')).toBe(
      '<p> "x" \'y\' &  '
    )
  })

  it('decodes numeric and hex entities', () => {
    expect(decodeHtml('&#65;&#66;&#x43;')).toBe('ABC')
    expect(decodeHtml('&#x1F600;')).toBe('😀')
  })

  it('drops out-of-range and surrogate code points', () => {
    expect(decodeHtml('&#xD800;')).toBe('')
    expect(decodeHtml('&#x110000;')).toBe('')
    expect(decodeHtml('&#-1;')).toBe('&#-1;')
  })

  it('decodes &amp; last so a literal "&amp;lt;" stays "&lt;"', () => {
    expect(decodeHtml('&amp;lt;')).toBe('&lt;')
    expect(decodeHtml('&amp;amp;')).toBe('&amp;')
    expect(decodeHtml('&lt;')).toBe('<')
  })
})

describe('stripHtml', () => {
  it('skips script and style bodies', () => {
    const result = stripHtml(
      '<html><head><style>body{color:red}</style></head><body><p>Hello</p><script>var x = 1 < 2;</script><p>World</p></body></html>'
    )
    expect(result.text).toBe('Hello World')
  })

  it('extracts <title>', () => {
    expect(stripHtml('<head><title>My Page</title></head><body>x</body>').title).toBe('My Page')
  })

  it('prefers og:title over <title>', () => {
    const html =
      '<head><meta property="og:title" content="OG &amp; Title"><title>Doc title</title></head><body>x</body>'
    expect(stripHtml(html).title).toBe('OG & Title')
  })

  it('accepts name="og:title" and unquoted content', () => {
    expect(stripHtml('<meta name="og:title" content=unquoted-title>').title).toBe(
      'unquoted-title'
    )
  })

  it('decodes entities and collapses whitespace in text', () => {
    expect(stripHtml('<p>a\n\n   b &amp; c</p>').text).toBe('a b & c')
  })

  it('keeps the entity decode order for text (&amp;lt;)', () => {
    expect(stripHtml('<p>&amp;lt;</p>').text).toBe('&lt;')
  })

  it('removes comments', () => {
    expect(stripHtml('a<!-- hidden -->b').text).toBe('a b')
  })

  it('stops at an unclosed script instead of leaking its body', () => {
    expect(stripHtml('<p>ok</p><script>secret()').text).toBe('ok')
  })

  it('returns empty title and text for empty input', () => {
    expect(stripHtml('')).toEqual({ title: '', text: '' })
  })
})
