import {
  ConfigStatusSchema,
  ControlMetadataSchema,
  NanasaConfigSchema,
  PortalSnapshotSchema,
  type ConfigStatus,
  type ControlMetadata,
  type NanasaConfig,
  type PortalSnapshot,
} from "@nanasa/contracts";
import { z } from "zod";
import { CONTROL_API_PREFIX, type NanasaControlClient } from "../index.js";
import { request } from "./common.js";

const DocumentSchema = z.record(z.string(), z.unknown());

export class MetadataResource {
  public constructor(private readonly client: NanasaControlClient) {}

  public get(): Promise<ControlMetadata> {
    return this.client.request(`${CONTROL_API_PREFIX}/meta`, ControlMetadataSchema, {
      authenticate: false,
    });
  }

  public openApi(): Promise<Record<string, unknown>> {
    return this.client.request(`${CONTROL_API_PREFIX}/schema/openapi.json`, DocumentSchema, {
      authenticate: false,
    });
  }

  public eventSchema(): Promise<Record<string, unknown>> {
    return this.client.request(`${CONTROL_API_PREFIX}/schema/events.json`, DocumentSchema, {
      authenticate: false,
    });
  }

  public snapshot(): Promise<PortalSnapshot> {
    return request(this.client, `${CONTROL_API_PREFIX}/snapshot`, PortalSnapshotSchema);
  }

  public config(): Promise<NanasaConfig> {
    return request(this.client, `${CONTROL_API_PREFIX}/config`, NanasaConfigSchema);
  }

  public configStatus(): Promise<ConfigStatus> {
    return request(this.client, `${CONTROL_API_PREFIX}/config/status`, ConfigStatusSchema);
  }
}
