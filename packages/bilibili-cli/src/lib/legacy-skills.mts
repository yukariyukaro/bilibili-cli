/**
 * 旧 bilibili-cli Skill 的精确历史快照（只含路径/字节数/SHA256，不含旧业务源码）。
 *
 * 构造方式（仅开发期从本仓库 git 历史读取，运行时不访问 git/真实安装）：
 *   git ls-tree -r --name-only <commit>
 *   git show <commit>:<path>  ->  Buffer -> sha256 hex
 *
 * 57efd8d 是迁移前仓库根布局；45cf9a4/49c530e 是 skills/bilibili-cli 布局。
 * 每个提交派生两个允许变体：
 * - full：该提交完整 skill 文件集（.gitignore 为唯一可选文件，存在则必须匹配）；
 * - docs：仅 SKILL.md + references/cli-contract.md（纯文档）。
 * 运行时只接受 pristine 历史内容；未知/新增/自定义文件一律拒绝。
 */

export interface LegacySnapshotFile {
  path: string
  size: number
  sha256: string
  optional?: boolean
}

export type LegacyLayout = 'repo-root' | 'skills/bilibili-cli'
export type LegacyVariant = 'full' | 'docs'

export interface LegacySnapshot {
  commit: string
  layout: LegacyLayout
  variant: LegacyVariant
  version: string
  files: readonly LegacySnapshotFile[]
}

function file(path: string, size: number, sha256: string, optional = false): LegacySnapshotFile {
  return optional ? { path, size, sha256, optional: true } : { path, size, sha256 }
}

const FULL_57EFD8D: readonly LegacySnapshotFile[] = [
  file('.gitignore', 183, 'faa20632ac0729375fe5b2eda9e3dd5712d7163b5b56215d50e72c3a0460d141', true),
  file('LICENSE', 1451, '2eb778c5ea04a3c682ea796cf8ab4ef0d4677bc4b497a891d38459a2d8bfa821'),
  file('README.en.md', 4888, '085b33219ee2601f28ebf18c33fa95a033fb97fc901d6921b86c7ddc722be87c'),
  file('README.md', 4129, '5b61608a2144689a25154e763d82fba6997d227aec01530e52718bbed8e612ce'),
  file('SKILL.md', 5011, '754df925a558e5b03e97de7d179d65ce0b2de43e091acc85e5831fe0e63300d7'),
  file('cli/bili.mjs', 10391, '28b22e8c4855dc32e422e7ee47dc6cca03b1291c0d61ea50e4ee5d49bfd6b29d'),
  file('lib/login.mjs', 4967, '2598c0e3df6405c12c6a70e7e03ba4600fe1fc5d330c77d33aa7bc8dcb16099a'),
  file('lib/mcp.mjs', 4561, 'f6321b4a685948a35a9939160423d315483e910f68a18bec93d3a8b6477c542f'),
  file('lib/portable.mjs', 1528, '44e8814a61062c7e81222ae65018aea55d159396999e1c9172e0fe69fdcd090b'),
  file('lib/uvfetch.mjs', 7641, '7d62a7b15d786f5c0dab693ddce48e09167a36f5cddd89359c07892d0ab46387'),
  file('package-lock.json', 6102, '47da5896ee3df9a86205dae29a0e962ab88f62c5019cba3a8a372d46db15eaab'),
  file('package.json', 374, 'e1fd37b7220557ed73c36c980bc696fd2e2466bccf7095db61f042b23e1facfd'),
  file('references/cli-contract.md', 7467, 'e5da2f434dc0896975e775262fb73b263846053747cc69a36543fb5056a648d4'),
  file('scripts/fixtures/audit.mjs', 359, '0bc27b75c8c2373535ae2bf579a0a4bdf0e9343edfa30a546676af01c9801700'),
  file('scripts/fixtures/delete_test.py', 2505, 'd4bcd775f6677ec339b621a5eb281e591025503e664c6a76a2e31b03a6627bd7'),
  file('scripts/fixtures/login.mjs', 595, '673c704a485cf5a8244e2aa7540c0b1941e5f8a9ff32e25f23e8a150a5980ae4'),
  file('scripts/fixtures/mcp.mjs', 1055, 'b344331f0c21584e55eb8f9032fd5a74c38632bf9b37cc4980b40667fef6983a'),
  file('scripts/fixtures/python-hook.mjs', 264, '713e0b52a46bd88f8bea63935ed5041fd845849c406fb8a526f543317bc8e0b0'),
  file('scripts/fixtures/python-loader.mjs', 96, '97c60b55d87de68edf12bb0bdc5cdf97343e58330eb4c57e51407c4e7cd4d751'),
  file('scripts/verify.mjs', 16584, '90ed4ee3f8c28ee9d53a4a9e80c72a5cc8857ae27e865c0016565e77177ebccb'),
  file('vendor/bilibili-mcp/LICENSE', 1067, '613dc22ea40922528e661ff5112c207a87c5fd323b8f24202b06e69317cc888e'),
  file('vendor/bilibili-mcp/mcp_server.py', 45301, 'ea2059ad89751c1ba149cabad1751e9776b370ef1768e4c8f857e96834213838'),
  file('vendor/bilibili-mcp/requirements.txt', 387, 'a611717516d645a3ee9ae3a739275a04b79f02fcf380af73b3d9b606cd85e733'),
]

const FULL_45CF9A4: readonly LegacySnapshotFile[] = [
  file('.gitignore', 183, 'faa20632ac0729375fe5b2eda9e3dd5712d7163b5b56215d50e72c3a0460d141', true),
  file('LICENSE', 1535, 'eb44aa6b6f4e92c1b1ebf07626a81490e05e528ae098044f7df8faa2b2276d38'),
  file('README.md', 2541, 'c89c548a14fcef335afca6a6f445e1d81c83b77c78029f28f03495f6edf010a2'),
  file('SKILL.md', 4077, '2e4035f39fdb496e4328ee8244e6e5c97b9d05c24b7e68fdb078da60df25de93'),
  file('cli/bili.mjs', 76, '06432b88ca6befd3d9a3d9e9fbc3c72258d8936a948fafdf050b7103b990e159'),
  file('lib/application.mjs', 5301, '99b6e1ef6dfc237e4cc315ab2e94d5160d2fbfd80cba26e8ac47ba58cf222136'),
  file('lib/command.mjs', 5050, '8290864a7ba0a8802daf5f1031a1616755757d385df2a56a4d1955a01f6e1980'),
  file('lib/contract.mjs', 6584, '1d8294df640c4451bc664a8315885c380d2cb86a6b9890c60831955d1141a6f8'),
  file('lib/login.mjs', 4683, '1e2d9dc8ae6fc1b87c0f0c8630cdb313dbc7cc0eb39ee79405e55e489bd00dbe'),
  file('lib/portable.mjs', 1079, 'eac60beea1652bf2e2cf400277dc377768359c8134fe4bd95424378290bd65d4'),
  file('lib/runtime.mjs', 1707, '71e05e3acf1c5d5970f6775159acb39d6dd4f1fc86825890f5b7c553dfeba082'),
  file('lib/service.mjs', 12071, 'b5eb692f8468fe9283af03acac4cbf8fb3f6c2d866ab85b3b63826b533317aba'),
  file('package-lock.json', 12241, '270af7215775c7abe7b271f35997dc2531bd2cff9a9f8ebb2f0755a50f7ac116'),
  file('package.json', 596, 'ac25913adfba881f6bf2bc615dd808ccc3d368a1a22c9076e69fe66ffd8aa1b3'),
  file('references/cli-contract.md', 4632, '7f457e28fae4546aae19fc952ceede094589d49c32181f5e31d5c393da12701e'),
  file('scripts/build.mjs', 1205, 'fad25e89e76f42f9ae037d7148ee4cd944a7027d69ac25a6dfd96ebac4b021aa'),
  file('scripts/closure.mjs', 2616, '34dcfd2baf9f6c6effe22bafabb277cbf2134741d168e5bdb0978426b301f662'),
  file('scripts/local-registry.mjs', 2864, '6eb1b0b235611dfc8a976ae47aa81f893046c2855a840920ce090d131e85ae1b'),
  file('scripts/verify.mjs', 14777, 'dd73f4385143c960179f3c0c1c9df98e632b83c73b1a621f726daf77a79def50'),
]

const FULL_49C530E: readonly LegacySnapshotFile[] = [
  file('.gitignore', 183, 'faa20632ac0729375fe5b2eda9e3dd5712d7163b5b56215d50e72c3a0460d141', true),
  file('LICENSE', 1535, 'eb44aa6b6f4e92c1b1ebf07626a81490e05e528ae098044f7df8faa2b2276d38'),
  file('README.md', 2541, 'c89c548a14fcef335afca6a6f445e1d81c83b77c78029f28f03495f6edf010a2'),
  file('SKILL.md', 4165, 'b9ee5c8799d4c0a2b098b8c406d0dd473475c8c47dc11df64d0796c50aca828e'),
  file('cli/bili.mjs', 76, '06432b88ca6befd3d9a3d9e9fbc3c72258d8936a948fafdf050b7103b990e159'),
  file('lib/application.mjs', 5301, '99b6e1ef6dfc237e4cc315ab2e94d5160d2fbfd80cba26e8ac47ba58cf222136'),
  file('lib/command.mjs', 5050, '8290864a7ba0a8802daf5f1031a1616755757d385df2a56a4d1955a01f6e1980'),
  file('lib/contract.mjs', 6584, '1d8294df640c4451bc664a8315885c380d2cb86a6b9890c60831955d1141a6f8'),
  file('lib/login.mjs', 4683, '1e2d9dc8ae6fc1b87c0f0c8630cdb313dbc7cc0eb39ee79405e55e489bd00dbe'),
  file('lib/portable.mjs', 1079, 'eac60beea1652bf2e2cf400277dc377768359c8134fe4bd95424378290bd65d4'),
  file('lib/runtime.mjs', 1707, '71e05e3acf1c5d5970f6775159acb39d6dd4f1fc86825890f5b7c553dfeba082'),
  file('lib/service.mjs', 12071, 'b5eb692f8468fe9283af03acac4cbf8fb3f6c2d866ab85b3b63826b533317aba'),
  file('package-lock.json', 12241, '270af7215775c7abe7b271f35997dc2531bd2cff9a9f8ebb2f0755a50f7ac116'),
  file('package.json', 596, 'ac25913adfba881f6bf2bc615dd808ccc3d368a1a22c9076e69fe66ffd8aa1b3'),
  file('references/cli-contract.md', 4632, '7f457e28fae4546aae19fc952ceede094589d49c32181f5e31d5c393da12701e'),
  file('scripts/build.mjs', 1205, 'fad25e89e76f42f9ae037d7148ee4cd944a7027d69ac25a6dfd96ebac4b021aa'),
  file('scripts/closure.mjs', 2616, '34dcfd2baf9f6c6effe22bafabb277cbf2134741d168e5bdb0978426b301f662'),
  file('scripts/local-registry.mjs', 2864, '6eb1b0b235611dfc8a976ae47aa81f893046c2855a840920ce090d131e85ae1b'),
  file('scripts/verify.mjs', 14777, 'dd73f4385143c960179f3c0c1c9df98e632b83c73b1a621f726daf77a79def50'),
]

const DOC_ONLY_PATHS = new Set(['SKILL.md', 'references/cli-contract.md'])

function docsVariant(files: readonly LegacySnapshotFile[]): LegacySnapshotFile[] {
  return files
    .filter((entry) => DOC_ONLY_PATHS.has(entry.path))
    .map((entry) => ({ path: entry.path, size: entry.size, sha256: entry.sha256 }))
}

function snapshot(
  commit: string,
  layout: LegacyLayout,
  variant: LegacyVariant,
  version: string,
  files: readonly LegacySnapshotFile[],
): LegacySnapshot {
  return { commit, layout, variant, version, files }
}

export const LEGACY_SNAPSHOTS: readonly LegacySnapshot[] = [
  snapshot('57efd8d', 'repo-root', 'full', '0.1.5', FULL_57EFD8D),
  snapshot('57efd8d', 'repo-root', 'docs', '0.1.5', docsVariant(FULL_57EFD8D)),
  snapshot('45cf9a4', 'skills/bilibili-cli', 'full', '1.0.0', FULL_45CF9A4),
  snapshot('45cf9a4', 'skills/bilibili-cli', 'docs', '1.0.0', docsVariant(FULL_45CF9A4)),
  snapshot('49c530e', 'skills/bilibili-cli', 'full', '1.0.0', FULL_49C530E),
  snapshot('49c530e', 'skills/bilibili-cli', 'docs', '1.0.0', docsVariant(FULL_49C530E)),
]

/** 所有快照允许的文件路径（结构校验阶段使用，不读内容）。 */
export const LEGACY_FILE_PATHS: ReadonlySet<string> = new Set(
  LEGACY_SNAPSHOTS.flatMap((entry) => entry.files.map((fileEntry) => fileEntry.path)),
)

/** 所有快照允许的目录路径（结构校验阶段使用；不含根目录本身）。 */
export const LEGACY_DIRECTORY_PATHS: ReadonlySet<string> = buildDirectoryPaths()

function buildDirectoryPaths(): Set<string> {
  const directories = new Set<string>()
  for (const snapshotEntry of LEGACY_SNAPSHOTS) {
    for (const fileEntry of snapshotEntry.files) {
      const parts = fileEntry.path.split('/')
      let current = ''
      for (let index = 0; index < parts.length - 1; index += 1) {
        current = current ? current + '/' + parts[index] : parts[index]
        directories.add(current)
      }
    }
  }
  return directories
}

/** 某个快照要求的目录集合（文件路径的所有祖先目录，不含根目录本身）。 */
export function snapshotDirectories(snapshotEntry: LegacySnapshot): ReadonlySet<string> {
  const directories = new Set<string>()
  for (const fileEntry of snapshotEntry.files) {
    const parts = fileEntry.path.split('/')
    let current = ''
    for (let index = 0; index < parts.length - 1; index += 1) {
      current = current ? current + '/' + parts[index] : parts[index]
      directories.add(current)
    }
  }
  return directories
}

/**
 * 路径/目录集合是否完整匹配某个快照（.gitignore 仅在 full 中可选）。
 * 只比较路径，不读内容；返回的候选仍需逐文件 size/SHA256 校验。
 * 目录也要求精确一致，避免 docs 变体混入空的历史目录。
 */
export function candidateSnapshots(
  paths: readonly string[],
  directories: readonly string[],
): readonly LegacySnapshot[] {
  const pathSet = new Set(paths)
  const directorySet = new Set(directories)
  return LEGACY_SNAPSHOTS.filter((snapshotEntry) => {
    const allowedFiles = new Set(snapshotEntry.files.map((fileEntry) => fileEntry.path))
    for (const path of pathSet) {
      if (!allowedFiles.has(path)) return false
    }
    for (const fileEntry of snapshotEntry.files) {
      if (!fileEntry.optional && !pathSet.has(fileEntry.path)) return false
    }
    const expectedDirectories = snapshotDirectories(snapshotEntry)
    if (expectedDirectories.size !== directorySet.size) return false
    for (const directory of directorySet) {
      if (!expectedDirectories.has(directory)) return false
    }
    return true
  })
}