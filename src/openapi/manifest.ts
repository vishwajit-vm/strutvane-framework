/**
 * The resource manifest at `/.well-known/strutvane.json`: everything `@strutvane/ui` (or any
 * client) needs to render screens: resources, fields, labels, relations and, per requesting
 * actor, which actions are allowed. Built from the same definitions as the API, then passed
 * through the `manifest.build` hook so auth and files can add capabilities and widgets.
 *
 * @module
 */
import {
  type Actor,
  type FieldDescriptor,
  MANIFEST_VERSION,
  type PermissionProvider,
  type ResourceCapabilities,
  type ResourceDescriptor,
  type ResourceManifest,
} from '@strutvane/contracts'
import type { HookRegistry } from '@strutvane/core'
import { z } from 'zod'
import { permissionFor } from '../http/permissions.ts'
import {
  ACTION_PERMISSIONS,
  type ResolvedResource,
  type ResourceAction,
  routeEnabled,
} from '../http/resource.ts'
import { valueSchema } from '../model/schemas.ts'
import { queryFields } from '../query/fields.ts'

/** Options for {@link buildManifest}. */
export interface ManifestOptions {
  readonly app: { readonly name: string; readonly apiVersion: string }
  readonly resources: readonly ResolvedResource[]
  readonly permissions: PermissionProvider
  readonly hooks?: HookRegistry<Record<string, unknown>>
  readonly now?: () => Date
}

const WIDGETS: Readonly<Record<string, string>> = {
  text: 'textarea',
  decimal: 'decimal',
  boolean: 'switch',
  enum: 'select',
  date: 'date',
  datetime: 'datetime',
  json: 'json',
  belongsTo: 'relation-picker',
}

/** Field descriptors of a resource (hidden fields are never described). */
export function describeFields(resource: ResolvedResource): FieldDescriptor[] {
  const out: FieldDescriptor[] = []
  for (const f of queryFields(resource.definition).values()) {
    if (f.def.hidden) continue
    const schema = z.toJSONSchema(valueSchema(f.def), {
      target: 'draft-2020-12',
      unrepresentable: 'any',
    }) as Record<string, unknown>
    delete schema['$schema']
    out.push({
      name: f.key,
      type: f.key === 'id' ? 'id' : f.def.kind,
      label: f.def.label ?? f.key,
      ...(f.def.help !== undefined ? { help: f.def.help } : {}),
      required: f.def.required && f.def.default === undefined,
      nullable: !f.def.required,
      unique: f.def.unique,
      readOnly: f.def.readOnly || f.system,
      writeOnce: f.def.writeOnce,
      filterOperators: f.def.filterOperators,
      sortable: f.def.sortable,
      searchable: f.def.searchable,
      ...(f.def.values ? { enumValues: f.def.values } : {}),
      ...(f.def.kind === 'belongsTo'
        ? {
            relation: { kind: 'belongsTo' as const, target: f.def.target ?? '', foreignKey: f.key },
          }
        : {}),
      ...(WIDGETS[f.def.kind] ? { widget: WIDGETS[f.def.kind] } : {}),
      schema,
    })
  }
  for (const [key, rel] of Object.entries(resource.definition.relations)) {
    out.push({
      name: key,
      type: 'hasMany',
      label: key.charAt(0).toUpperCase() + key.slice(1),
      required: false,
      nullable: false,
      unique: false,
      readOnly: true,
      writeOnce: false,
      filterOperators: [],
      sortable: false,
      searchable: false,
      relation: { kind: 'hasMany', target: rel.target, foreignKey: rel.foreignKey },
    })
  }
  return out
}

/** Build the manifest for one actor (only the resources that actor can use at all). */
export async function buildManifest(
  actor: Actor | null,
  options: ManifestOptions,
): Promise<ResourceManifest> {
  const resources: ResourceDescriptor[] = []
  for (const resource of options.resources) {
    const m = resource.definition
    const allowed = async (action: ResourceAction): Promise<boolean> => {
      if (!routeEnabled(resource, action)) return false
      const permission = permissionFor(m.permission, ACTION_PERMISSIONS[action])
      const d = await options.permissions.can(actor, permission, { type: m.permission })
      if (d.allowed || action === 'create' || actor === null) return d.allowed
      // Row actions: allowed on SOME rows when the row filter is not FALSE (the same rule as the
      // API), so a member who may edit only their own records still gets an Edit button.
      const filter = await options.permissions.filterFor(actor, permission, m.permission)
      return filter.op !== 'false'
    }
    const capabilities: ResourceCapabilities = {
      list: await allowed('list'),
      view: await allowed('show'),
      create: await allowed('create'),
      update: await allowed('update'),
      delete: await allowed('delete'),
      restore: await allowed('restore'),
      export: false, // export routes are deferred
    }
    // A resource the actor can do nothing with is left out entirely: anonymous visitors (or
    // users without any grant) must not learn which resources and fields exist.
    if (!Object.values(capabilities).some(Boolean)) continue
    resources.push({
      name: m.name,
      path: m.path,
      label: m.label,
      pluralLabel: m.pluralLabel,
      titleField: m.title,
      fields: describeFields(resource),
      actions: [],
      capabilities,
      softDeletes: m.options.softDeletes,
      tenantScoped: m.options.tenant,
      audited: m.options.audit,
      ...(resource.ui ? { ui: resource.ui } : {}),
    })
  }
  const manifest: ResourceManifest = {
    manifestVersion: MANIFEST_VERSION,
    app: options.app,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    resources,
  }
  if (!options.hooks) return manifest
  const hooked = (await options.hooks.run('manifest.build', { actor, manifest })) as {
    manifest: ResourceManifest
  }
  return hooked.manifest
}
