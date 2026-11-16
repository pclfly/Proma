import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import AdmZip from 'adm-zip'
import type { EnterpriseSkillInstallDescriptor } from '@proma/shared'
import {
  EnterpriseSkillsError,
  MAX_ENTERPRISE_SKILL_FILES,
  assertNoSensitiveFile,
  assertSafeSkillSlug,
  calculateSkillManifest,
  checkEnterpriseSkillUpdates,
  createEnterpriseSkillArtifact,
  extractEnterpriseSkillArtifact,
  getEnterpriseSkill,
  getEnterpriseSkills,
  installEnterpriseSkillArtifact,
  isEnterpriseSkillSource,
  isSafeArchivePath,
  readEnterpriseSkillSource,
  setEnterpriseSkillsCloudApi,
  writeEnterpriseSkillSource,
  type EnterpriseSkillWorkspaceLayout,
} from './enterprise-skills-service'

/** 每个用例独立的临时根目录 */
const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeTempRoot(prefix = 'proma-enterprise-skills-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

/** 测试注入的工作区布局；默认 Skills 列表可控 */
function makeLayout(root: string, defaultSkillSlugs: string[] = []): EnterpriseSkillWorkspaceLayout {
  return {
    getWorkspaceSkillsDir: (slug) => join(root, slug, 'skills'),
    getInactiveSkillsDir: (slug) => join(root, slug, 'skills-inactive'),
    getDefaultSkillSlugs: () => defaultSkillSlugs,
  }
}

function writeSkillDir(dir: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(dir, relativePath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf-8')
  }
}

function makeSkillSource(root: string, slug = 'my-skill', files?: Record<string, string>): string {
  const dir = join(root, `src-${slug}`)
  writeSkillDir(dir, files ?? {
    'SKILL.md': '---\nname: My Skill\nversion: 1.0.0\n---\n\n# My Skill\n',
    'scripts/run.sh': 'echo hello\n',
  })
  return dir
}

function makeInstallDescriptor(overrides: Partial<EnterpriseSkillInstallDescriptor> = {}): EnterpriseSkillInstallDescriptor {
  return {
    id: 'skill-1',
    slug: 'my-skill',
    latestVersion: { id: 'version-1', version: '1.0.0', artifactSha256: 'a'.repeat(64) },
    ...overrides,
  }
}

function installFromDir(input: {
  layout: EnterpriseSkillWorkspaceLayout
  skillDir: string
  descriptor?: EnterpriseSkillInstallDescriptor
  enterpriseId?: string
}) {
  const artifact = createEnterpriseSkillArtifact(input.skillDir)
  return installEnterpriseSkillArtifact({
    workspaceSlug: 'workspace-a',
    skill: input.descriptor ?? makeInstallDescriptor(),
    enterpriseId: input.enterpriseId ?? 'enterprise-1',
    artifact,
    artifactSha256: 'a'.repeat(64),
    layout: input.layout,
  })
}

describe('企业 Skill 标识与路径校验', () => {
  test('Given 合法 slug When 校验 Then 通过', () => {
    expect(() => assertSafeSkillSlug('my-skill-2')).not.toThrow()
  })

  test('Given 大写/下划线/前导连字符/空 slug When 校验 Then 拒绝', () => {
    for (const slug of ['My-Skill', 'my_skill', '-my-skill', '']) {
      expect(() => assertSafeSkillSlug(slug)).toThrow(EnterpriseSkillsError)
    }
  })

  test('Given 普通相对路径 When 判断归档安全 Then true', () => {
    expect(isSafeArchivePath('SKILL.md')).toBe(true)
    expect(isSafeArchivePath('scripts/run.sh')).toBe(true)
    expect(isSafeArchivePath('a\\b\\c.txt')).toBe(true)
  })

  test('Given 绝对路径/盘符/穿越路径 When 判断归档安全 Then false', () => {
    expect(isSafeArchivePath('/etc/passwd')).toBe(false)
    expect(isSafeArchivePath('C:\\Windows\\system32')).toBe(false)
    expect(isSafeArchivePath('../evil.txt')).toBe(false)
    expect(isSafeArchivePath('a/../../evil.txt')).toBe(false)
    expect(isSafeArchivePath('')).toBe(false)
  })

  test('Given 敏感文件 When 校验 Then 拒绝', () => {
    for (const path of ['.env', 'config/.npmrc', 'keys/server.pem', '.ssh/id_rsa', '.aws/credentials', 'id_ed25519']) {
      expect(() => assertNoSensitiveFile(path)).toThrow('敏感文件')
    }
  })

  test('Given 普通文件 When 校验敏感文件 Then 通过', () => {
    expect(() => assertNoSensitiveFile('SKILL.md')).not.toThrow()
    expect(() => assertNoSensitiveFile('scripts/run.sh')).not.toThrow()
    expect(() => assertNoSensitiveFile('docs/credentials.md')).not.toThrow()
  })
})

describe('企业来源元数据', () => {
  test('Given 企业来源形状 When 判断 Then true', () => {
    expect(isEnterpriseSkillSource({
      schemaVersion: 2,
      type: 'enterprise-library',
      enterpriseId: 'e1',
      skillId: 's1',
      versionId: 'v1',
      installedVersion: '1.0.0',
      artifactSha256: 'a'.repeat(64),
      baseManifestSha256: 'b'.repeat(64),
      installedAt: '2026-01-01T00:00:00.000Z',
    })).toBe(true)
  })

  test('Given 工作区导入来源/损坏 JSON/非对象 When 判断 Then false', () => {
    expect(isEnterpriseSkillSource({ sourceWorkspaceSlug: 'a', sourceWorkspaceName: 'A' })).toBe(false)
    expect(isEnterpriseSkillSource({ type: 'enterprise-library', schemaVersion: 1 })).toBe(false)
    expect(isEnterpriseSkillSource(null)).toBe(false)
    expect(isEnterpriseSkillSource('enterprise-library')).toBe(false)
  })

  test('Given 写入来源 When 读取 Then 字段完整且无临时残留', () => {
    const root = makeTempRoot()
    const dir = join(root, 'skill')
    mkdirSync(dir)
    writeEnterpriseSkillSource(dir, {
      schemaVersion: 2,
      type: 'enterprise-library',
      enterpriseId: 'e1',
      skillId: 's1',
      versionId: 'v1',
      installedVersion: '1.0.0',
      artifactSha256: 'a'.repeat(64),
      baseManifestSha256: 'b'.repeat(64),
      installedAt: '2026-01-01T00:00:00.000Z',
    })

    expect(readEnterpriseSkillSource(dir)?.skillId).toBe('s1')
    expect(readdirSync(dir)).toEqual(['.source.json'])
  })

  test('Given 工作区导入来源 When 读取企业来源 Then undefined', () => {
    const root = makeTempRoot()
    const dir = join(root, 'skill')
    mkdirSync(dir)
    writeFileSync(join(dir, '.source.json'), JSON.stringify({ sourceWorkspaceSlug: 'a', sourceWorkspaceName: 'A' }), 'utf-8')
    expect(readEnterpriseSkillSource(dir)).toBeUndefined()
  })
})

describe('Skill 制品打包', () => {
  test('Given 含子目录的 Skill When 打包 Then 包含全部文件且排除 .source.json', () => {
    const root = makeTempRoot()
    const skillDir = makeSkillSource(root)
    writeFileSync(join(skillDir, '.source.json'), '{"type":"enterprise-library"}', 'utf-8')

    const artifact = createEnterpriseSkillArtifact(skillDir)
    const zip = new AdmZip(artifact)
    const names = zip.getEntries().map((entry) => entry.entryName).sort()

    expect(names).toEqual(['SKILL.md', 'scripts/run.sh'])
  })

  test('Given 缺少 SKILL.md When 打包 Then 拒绝', () => {
    const root = makeTempRoot()
    const skillDir = join(root, 'no-md')
    writeSkillDir(skillDir, { 'readme.txt': 'x' })
    expect(() => createEnterpriseSkillArtifact(skillDir)).toThrow('SKILL.md')
  })

  test('Given 目录含敏感文件 When 打包 Then 拒绝', () => {
    const root = makeTempRoot()
    const skillDir = makeSkillSource(root)
    writeFileSync(join(skillDir, '.env'), 'TOKEN=1', 'utf-8')
    expect(() => createEnterpriseSkillArtifact(skillDir)).toThrow('敏感文件')
  })

  test('Given 文件数超过上限 When 打包 Then 拒绝', () => {
    const root = makeTempRoot()
    const skillDir = makeSkillSource(root)
    const files: Record<string, string> = {}
    for (let i = 0; i <= MAX_ENTERPRISE_SKILL_FILES; i += 1) {
      files[`files/f-${i}.txt`] = `${i}`
    }
    writeSkillDir(skillDir, files)
    expect(() => createEnterpriseSkillArtifact(skillDir)).toThrow(`超过 ${MAX_ENTERPRISE_SKILL_FILES}`)
  })

  test('Given 目录含符号链接 When 打包 Then 拒绝（无法创建链接时跳过）', () => {
    const root = makeTempRoot()
    const skillDir = makeSkillSource(root)
    const target = join(root, 'outside.txt')
    writeFileSync(target, 'outside', 'utf-8')
    try {
      symlinkSync(target, join(skillDir, 'link.txt'))
    } catch {
      // Windows 未开启开发者模式时普通用户无法创建符号链接，跳过该用例。
      return
    }
    expect(() => createEnterpriseSkillArtifact(skillDir)).toThrow('符号链接')
  })
})

describe('Skill 清单', () => {
  test('Given 相同内容 When 计算清单 Then 稳定且忽略 .source.json', () => {
    const root = makeTempRoot()
    const skillDir = makeSkillSource(root)
    const before = calculateSkillManifest(skillDir)

    writeFileSync(join(skillDir, '.source.json'), JSON.stringify({
      schemaVersion: 2,
      type: 'enterprise-library',
      skillId: 's1',
      versionId: 'v1',
    }), 'utf-8')

    expect(calculateSkillManifest(skillDir)).toBe(before)
  })

  test('Given 内容变化 When 计算清单 Then 摘要变化', () => {
    const root = makeTempRoot()
    const skillDir = makeSkillSource(root)
    const before = calculateSkillManifest(skillDir)
    writeFileSync(join(skillDir, 'scripts/run.sh'), 'echo changed\n', 'utf-8')
    expect(calculateSkillManifest(skillDir)).not.toBe(before)
  })
})

describe('Skill 制品解包', () => {
  test('Given 合法制品 When 解包 Then 文件落盘且清单与源目录一致', () => {
    const root = makeTempRoot()
    const skillDir = makeSkillSource(root)
    const artifact = createEnterpriseSkillArtifact(skillDir)
    const destination = join(root, 'extract')

    const summary = extractEnterpriseSkillArtifact(artifact, destination)

    expect(summary.fileCount).toBe(2)
    expect(summary.manifestSha256).toBe(calculateSkillManifest(skillDir))
    expect(readFileSync(join(destination, 'scripts/run.sh'), 'utf-8')).toBe('echo hello\n')
  })

  test('Given 空制品 When 解包 Then 拒绝', () => {
    const root = makeTempRoot()
    expect(() => extractEnterpriseSkillArtifact(Buffer.alloc(0), join(root, 'out'))).toThrow('制品大小无效')
  })

  test('Given 制品缺少 SKILL.md When 解包 Then 拒绝', () => {
    const root = makeTempRoot()
    const zip = new AdmZip()
    zip.addFile('readme.txt', Buffer.from('x'))
    expect(() => extractEnterpriseSkillArtifact(zip.toBuffer(), join(root, 'out'))).toThrow('缺少 SKILL.md')
  })

  test('Given 制品含穿越路径 When 解包 Then 拒绝且不写出目标目录', () => {
    const root = makeTempRoot()
    const destination = join(root, 'nested', 'out')
    const zip = new AdmZip()
    zip.addFile('SKILL.md', Buffer.from('---\nname: x\n---\n'))
    // adm-zip 的 addFile 会规范化 `..`，因此直接改写条目名来模拟恶意压缩包。
    const traversalEntry = zip.addFile('placeholder.txt', Buffer.from('evil'))
    traversalEntry.entryName = '../evil.txt'

    expect(() => extractEnterpriseSkillArtifact(zip.toBuffer(), destination)).toThrow('非法路径')
    expect(existsSync(join(root, 'nested', 'evil.txt'))).toBe(false)
  })

  test('Given 制品含 __MACOSX 条目 When 解包 Then 拒绝', () => {
    const root = makeTempRoot()
    const zip = new AdmZip()
    zip.addFile('SKILL.md', Buffer.from('---\nname: x\n---\n'))
    zip.addFile('__MACOSX/._SKILL.md', Buffer.from('x'))
    expect(() => extractEnterpriseSkillArtifact(zip.toBuffer(), join(root, 'out'))).toThrow('非法路径')
  })

  test('Given 制品含大小写重复路径 When 解包 Then 拒绝', () => {
    const root = makeTempRoot()
    const zip = new AdmZip()
    zip.addFile('SKILL.md', Buffer.from('---\nname: x\n---\n'))
    zip.addFile('Notes.md', Buffer.from('a'))
    zip.addFile('notes.md', Buffer.from('b'))
    expect(() => extractEnterpriseSkillArtifact(zip.toBuffer(), join(root, 'out'))).toThrow('重复路径')
  })

  test('Given 制品含符号链接条目 When 解包 Then 拒绝', () => {
    const root = makeTempRoot()
    const zip = new AdmZip()
    zip.addFile('SKILL.md', Buffer.from('---\nname: x\n---\n'))
    const linkEntry = zip.addFile('link.txt', Buffer.from('/etc/passwd'))
    linkEntry.attr = (0o120777 << 16) >>> 0

    expect(() => extractEnterpriseSkillArtifact(zip.toBuffer(), join(root, 'out'))).toThrow('符号链接')
  })
})

describe('企业 Skill 安装', () => {
  test('Given 空工作区 When 安装 Then 落到 active 目录并写入来源', () => {
    const root = makeTempRoot()
    const layout = makeLayout(root)
    const result = installFromDir({ layout, skillDir: makeSkillSource(root) })

    const skillDir = join(layout.getWorkspaceSkillsDir('workspace-a'), 'my-skill')
    expect(result.installedVersion).toBe('1.0.0')
    expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true)
    expect(readEnterpriseSkillSource(skillDir)?.skillId).toBe('skill-1')
    expect(readEnterpriseSkillSource(skillDir)?.enterpriseId).toBe('enterprise-1')
    expect(readdirSync(layout.getWorkspaceSkillsDir('workspace-a')).sort()).toEqual(['my-skill'])
  })

  test('Given 同一企业 Skill 未修改 When 安装新版本 Then 覆盖并更新版本', () => {
    const root = makeTempRoot()
    const layout = makeLayout(root)
    const skillDir = makeSkillSource(root)
    installFromDir({ layout, skillDir })

    const result = installFromDir({
      layout,
      skillDir,
      descriptor: makeInstallDescriptor({ latestVersion: { id: 'version-2', version: '1.1.0' } }),
    })

    const installedDir = join(layout.getWorkspaceSkillsDir('workspace-a'), 'my-skill')
    expect(result.installedVersion).toBe('1.1.0')
    expect(readEnterpriseSkillSource(installedDir)?.versionId).toBe('version-2')
  })

  test('Given 本地已修改企业 Skill When 安装 Then 拒绝覆盖且保留修改', () => {
    const root = makeTempRoot()
    const layout = makeLayout(root)
    const skillDir = makeSkillSource(root)
    installFromDir({ layout, skillDir })

    const installedDir = join(layout.getWorkspaceSkillsDir('workspace-a'), 'my-skill')
    writeFileSync(join(installedDir, 'SKILL.md'), 'local edit', 'utf-8')

    expect(() => installFromDir({
      layout,
      skillDir,
      descriptor: makeInstallDescriptor({ latestVersion: { id: 'version-2', version: '1.1.0' } }),
    })).toThrow('本地 Skill 已修改')
    expect(readFileSync(join(installedDir, 'SKILL.md'), 'utf-8')).toBe('local edit')
  })

  test('Given 同名非企业 Skill When 安装 Then 冲突', () => {
    const root = makeTempRoot()
    const layout = makeLayout(root)
    const existing = join(layout.getWorkspaceSkillsDir('workspace-a'), 'my-skill')
    writeSkillDir(existing, { 'SKILL.md': '---\nname: local\n---\n' })

    expect(() => installFromDir({ layout, skillDir: makeSkillSource(root) })).toThrow('来源不同')
  })

  test('Given slug 与内置 Skill 同名 When 安装 Then 冲突', () => {
    const root = makeTempRoot()
    const layout = makeLayout(root, ['my-skill'])
    expect(() => installFromDir({ layout, skillDir: makeSkillSource(root) })).toThrow('内置 Skill')
  })

  test('Given 本地已禁用企业 Skill When 安装 Then 在 inactive 目录更新', () => {
    const root = makeTempRoot()
    const layout = makeLayout(root)
    installFromDir({ layout, skillDir: makeSkillSource(root) })

    // 模拟用户禁用：把目录移到 skills-inactive
    const activeDir = join(layout.getWorkspaceSkillsDir('workspace-a'), 'my-skill')
    const inactiveDir = join(layout.getInactiveSkillsDir('workspace-a'), 'my-skill')
    mkdirSync(layout.getInactiveSkillsDir('workspace-a'), { recursive: true })
    // renameSync 需要目标父目录存在，且源目录完整
    renameSync(activeDir, inactiveDir)

    const result = installFromDir({
      layout,
      skillDir: makeSkillSource(root),
      descriptor: makeInstallDescriptor({ latestVersion: { id: 'version-2', version: '1.1.0' } }),
    })

    expect(result.installedVersion).toBe('1.1.0')
    expect(existsSync(join(inactiveDir, 'SKILL.md'))).toBe(true)
    expect(existsSync(activeDir)).toBe(false)
  })

  test('Given 制品损坏 When 安装 Then 不创建目标目录且清理暂存', () => {
    const root = makeTempRoot()
    const layout = makeLayout(root)
    const zip = new AdmZip()
    zip.addFile('readme.txt', Buffer.from('x'))

    expect(() => installEnterpriseSkillArtifact({
      workspaceSlug: 'workspace-a',
      skill: makeInstallDescriptor(),
      enterpriseId: 'enterprise-1',
      artifact: zip.toBuffer(),
      artifactSha256: 'a'.repeat(64),
      layout,
    })).toThrow('缺少 SKILL.md')

    const skillsDir = layout.getWorkspaceSkillsDir('workspace-a')
    expect(existsSync(join(skillsDir, 'my-skill'))).toBe(false)
    expect(readdirSync(skillsDir)).toEqual([])
  })
})

describe('企业 Skills 云端未接入时的降级行为', () => {
  test('Given 未注入 Cloud API When 列出企业 Skill Then 返回禁用状态', async () => {
    const result = await getEnterpriseSkills()
    expect(result.items).toEqual([])
    expect(result.availability.enabled).toBe(false)
    expect(result.availability.reason).toBeTruthy()
  })

  test('Given 未注入 Cloud API When 获取单个企业 Skill Then 抛 UNAVAILABLE', async () => {
    await expect(getEnterpriseSkill('skill-1')).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  test('Given 已安装企业 Skill 且未注入 Cloud API When 检查更新 Then 空列表', async () => {
    const root = makeTempRoot()
    const layout = makeLayout(root)
    installFromDir({ layout, skillDir: makeSkillSource(root) })

    const result = await checkEnterpriseSkillUpdates('workspace-a', [{ slug: 'my-skill' }], layout)
    expect(result.updates).toEqual([])
  })

  test('Given 已安装企业 Skill 但 Cloud API 抛错 When 检查更新 Then 吞掉错误返回空列表', async () => {
    const root = makeTempRoot()
    const layout = makeLayout(root)
    installFromDir({ layout, skillDir: makeSkillSource(root) })

    setEnterpriseSkillsCloudApi({
      list: async () => ({ items: [], availability: { enabled: true } }),
      get: async () => { throw new Error('boom') },
      publish: async () => { throw new Error('boom') },
      publishVersion: async () => { throw new Error('boom') },
      requestArtifactDownload: async () => { throw new Error('boom') },
      fetchArtifact: async () => { throw new Error('boom') },
      checkUpdates: async () => { throw new Error('boom') },
    })
    try {
      const result = await checkEnterpriseSkillUpdates('workspace-a', [{ slug: 'my-skill' }], layout)
      expect(result.updates).toEqual([])
    } finally {
      setEnterpriseSkillsCloudApi(undefined)
    }
  })
})

describe('企业 Skills 云端未接入时的降级行为（续）', () => {
  test('Given 注入的 Cloud API 可用 When 列出 Then 透传结果', async () => {
    setEnterpriseSkillsCloudApi({
      list: async () => ({
        items: [{
          id: 'skill-1',
          slug: 'my-skill',
          latestVersion: { id: 'v1', version: '1.0.0' },
          policy: { enterpriseId: 'e1' },
        }],
        availability: { enabled: true },
      }),
      get: async () => { throw new Error('boom') },
      publish: async () => { throw new Error('boom') },
      publishVersion: async () => { throw new Error('boom') },
      requestArtifactDownload: async () => { throw new Error('boom') },
      fetchArtifact: async () => { throw new Error('boom') },
      checkUpdates: async () => ({ updates: [] }),
    })
    try {
      const result = await getEnterpriseSkills()
      expect(result.availability.enabled).toBe(true)
      expect(result.items[0]?.slug).toBe('my-skill')
    } finally {
      setEnterpriseSkillsCloudApi(undefined)
    }
  })
})
