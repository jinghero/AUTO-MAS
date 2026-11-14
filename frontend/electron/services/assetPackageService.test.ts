import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { crc32 } from 'node:zlib'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import {
  AssetPackageStore,
  normalizePackageInfo,
  assertPlainObject,
  assertAssetPath,
} from './assetPackageService'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==',
  'base64'
)
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mas-package-test-'))
  roots.push(root)
  const store = new AssetPackageStore({
    directoryName: 'mascots',
    manifestName: 'mascot.json',
    normalize(raw) {
      const info = normalizePackageInfo(raw, 'mascot.json')
      const value = assertPlainObject(raw, 'mascot.json')
      return { ...info, image: assertAssetPath(value.image, true) }
    },
    referencedPaths: manifest => [manifest.image],
    validateAssets: () => {},
  })
  const zip = new AdmZip()
  zip.addFile(
    'mascot.json',
    Buffer.from(
      JSON.stringify({ formatVersion: 1, id: 'test', name: 'Test', image: 'assets/pet.png' })
    )
  )
  zip.addFile('assets/pet.png', image)
  return {
    root,
    store,
    zip,
    file: path.join(root, 'package.zip'),
    output: path.join(root, 'output'),
  }
}

describe('外部资源 ZIP 校验', () => {
  it('允许超过 8 MiB 的图片及超过 32 个目录项，并按原内容落盘', async () => {
    const { root, store, zip, file, output } = fixture()
    const text = Buffer.alloc(9 * 1024 * 1024, 120)
    text.write('comment\0')
    const header = Buffer.alloc(8)
    header.writeUInt32BE(text.length)
    header.write('tEXt', 4)
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE(crc32(text, crc32(Buffer.from('tEXt'))))
    const png = Buffer.concat([image.subarray(0, -12), header, text, checksum, image.subarray(-12)])
    zip.updateFile('assets/pet.png', png)
    for (let i = 0; i < 40; i++) zip.addFile(`empty-${i}/`, Buffer.alloc(0))
    zip.writeZip(file)
    const pack = await store.readArchive(file, output)
    expect(createHash('sha256').update(fs.readFileSync(pack.files[0].source)).digest('hex')).toBe(
      createHash('sha256').update(png).digest('hex')
    )
    expect(store.install(path.join(root, 'user'), pack).success).toBe(true)
    fs.rmSync(pack.directory, { recursive: true })
  })

  it('在读取正文前拒绝超出展开预算的声明，不留下暂存目录', async () => {
    const { store, zip, file, output } = fixture()
    const bytes = zip.toBuffer()
    let offset = bytes.indexOf(Buffer.from('504b0102', 'hex'))
    while (offset >= 0) {
      bytes.writeUInt32LE(201 * 1024 * 1024, offset + 24)
      offset = bytes.indexOf(Buffer.from('504b0102', 'hex'), offset + 4)
    }
    fs.writeFileSync(file, bytes)
    await expect(store.readArchive(file, output)).rejects.toMatchObject({ code: 'INVALID_PACKAGE' })
    expect(fs.existsSync(output)).toBe(false)
  })

  it('拒绝 CRC 不匹配的资源，并清理部分展开结果', async () => {
    const { store, zip, file, output } = fixture()
    const bytes = zip.toBuffer()
    let offset = bytes.indexOf(Buffer.from('504b0102', 'hex'))
    while (offset >= 0) {
      if (
        bytes
          .subarray(offset + 46, offset + 60)
          .toString()
          .startsWith('assets/pet.png')
      )
        bytes.writeUInt32LE(0, offset + 16)
      offset = bytes.indexOf(Buffer.from('504b0102', 'hex'), offset + 4)
    }
    fs.writeFileSync(file, bytes)
    await expect(store.readArchive(file, output)).rejects.toMatchObject({ code: 'INVALID_PACKAGE' })
    expect(fs.readdirSync(output)).toEqual([])
  })
})
