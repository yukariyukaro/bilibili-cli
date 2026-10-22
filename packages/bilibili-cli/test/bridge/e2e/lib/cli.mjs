import { join } from 'node:path'
import {
  IS_WINDOWS,
  PATH_DELIMITER,
  WORKDIR,
  resolveInstalledPrefix,
} from './env.mjs'
import {
  auditStat,
  authStatus,
  bilibiliOk,
  bridgeStatus,
  bridgeStop,
  configGet,
  dmRead,
  dmStatus,
  doctor,
  installedVersion,
  runBilibili,
  runBilibiliRaw,
  runJsonl,
  schema,
  skillsList,
} from '../../lib/cli.mjs'

export {
  auditStat,
  authStatus,
  bilibiliOk,
  bridgeStatus,
  bridgeStop,
  configGet,
  dmRead,
  dmStatus,
  doctor,
  installedVersion,
  runBilibili,
  runBilibiliRaw,
  runJsonl,
  schema,
  skillsList,
}

export { IS_WINDOWS, PATH_DELIMITER, WORKDIR, resolveInstalledPrefix, join }
