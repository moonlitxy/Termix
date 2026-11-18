export interface RemotePathMemory {
  paths: Record<string, string>;
  path: string;
}

/** 切换 SFTP 连接时保存旧连接路径，并恢复目标连接上次的路径。 */
export function switchRemotePath(
  paths: Record<string, string>,
  previous: { connectionId: string; path: string } | null,
  nextConnectionId: string | null
): RemotePathMemory {
  const nextPaths = previous
    ? { ...paths, [previous.connectionId]: previous.path }
    : { ...paths };
  return {
    paths: nextPaths,
    path: nextConnectionId ? (nextPaths[nextConnectionId] ?? "/") : "/",
  };
}
