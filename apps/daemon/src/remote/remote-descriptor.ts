import {
  type BuildIdentity,
  type ControlMetadata,
  type RemoteDescriptor,
  RemoteDescriptorSchema,
  type ServiceDescriptor,
} from "@nanasa/contracts";

export function createRemoteDescriptor(options: {
  repositoryId: string;
  instanceId: string;
  build: BuildIdentity;
  service: ServiceDescriptor;
  host?: "127.0.0.1" | "::1";
  port?: number;
}): RemoteDescriptor {
  return RemoteDescriptorSchema.parse({
    formatVersion: 1,
    repositoryId: options.repositoryId,
    instanceId: options.instanceId,
    build: { packageVersion: options.build.packageVersion, commit: options.build.commit },
    apiVersion: options.build.apiVersion,
    eventProtocolVersion: options.build.eventProtocolVersion,
    terminalProtocolVersion: options.build.terminalProtocolVersion,
    service: {
      instanceName: options.service.instanceName,
      unitName: options.service.unitName,
      state: options.service.state,
    },
    loopbackHost: options.host ?? "127.0.0.1",
    port: options.port ?? 3210,
  });
}

export function createRemoteDescriptorFromMetadata(
  metadata: ControlMetadata,
  service: ServiceDescriptor,
  host: "127.0.0.1" | "::1" = "127.0.0.1",
  port = 3210,
): RemoteDescriptor {
  return RemoteDescriptorSchema.parse({
    formatVersion: 1,
    repositoryId: metadata.repositoryId,
    instanceId: metadata.instanceId,
    build: { packageVersion: metadata.productVersion, commit: metadata.buildCommit },
    apiVersion: metadata.apiVersion,
    eventProtocolVersion: metadata.eventProtocolVersion,
    terminalProtocolVersion: 1,
    service: {
      instanceName: service.instanceName,
      unitName: service.unitName,
      state: service.state,
    },
    loopbackHost: host,
    port,
  });
}

export function assertCompatibleRemote(local: BuildIdentity, remote: RemoteDescriptor): void {
  if (
    remote.apiVersion !== local.apiVersion ||
    remote.eventProtocolVersion !== local.eventProtocolVersion ||
    remote.terminalProtocolVersion !== local.terminalProtocolVersion
  ) {
    throw new Error("Remote Nanasa protocols are incompatible with this client");
  }
}
