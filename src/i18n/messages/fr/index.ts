import commit from './commit'
import common from './common'
import diff from './diff'
import forge from './forge'
import graph from './graph'
import nav from './nav'
import ops from './ops'
import search from './search'
import settings from './settings'
import shell from './shell'
import status from './status'
import workbench from './workbench'
import workspaces from './workspaces'

const messages = {
  ...common,
  ...nav,
  ...shell,
  ...status,
  ...graph,
  ...diff,
  ...workbench,
  ...commit,
  ...search,
  ...ops,
  ...forge,
  ...settings,
  ...workspaces,
}

export default messages
