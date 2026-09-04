import { Hono } from 'hono';
import { z } from 'zod';

import {
  createSavedTaskFilterRequestSchema,
  deleteSavedTaskFilterRequestSchema,
  savedTaskFilterListResponseSchema,
  savedTaskFilterSchema,
  taskFilterListSchema,
  taskFilterUserSearchRequestSchema,
  taskFilterUserSearchResponseSchema,
  updateSavedTaskFilterRequestSchema,
} from '@task-commander/contracts';

import type { VerifiedSessionPrincipal } from '../auth/session-service';
import {
  createDataAccessContext,
  EffectiveAccessError,
  requirePermission,
  type DataAccessContext,
  type EffectiveAccess,
} from '../data/access';
import type { Json } from '../data/database.types';
import type { SavedFilter } from '../data/repositories';
import { ApiHttpError } from '../http/errors';
import { parseJsonBody } from '../http/validation';
import type {
  BitrixAdapter,
  BitrixResult,
  EmployeeSearchPage,
} from '../integrations/bitrix/contract';
import { employeeSearchPageSchema } from '../integrations/bitrix/schemas';
import type { RuntimeEnvironment } from '../runtime/configuration';
import {
  createTaskFilterCatalog,
  InvalidTaskSearchDefinitionError,
  requireValidTaskFilters,
} from './catalog';
import { throwTaskFilterDataApiError, toTaskFilterBitrixApiError } from './errors';

export type TaskFilterRepository = Readonly<{
  ensurePrincipalIdentity(context: DataAccessContext, displayName: string): Promise<void>;
  listSavedFilters(context: DataAccessContext): Promise<SavedFilter[]>;
  createSavedFilter(
    context: DataAccessContext,
    input: { name: string; filterPayload: Json },
  ): Promise<SavedFilter>;
  updateSavedFilter(
    context: DataAccessContext,
    input: { id: string; expectedRevision: number; name: string },
  ): Promise<SavedFilter>;
  deleteSavedFilter(
    context: DataAccessContext,
    input: { id: string; expectedRevision: number },
  ): Promise<void>;
}>;

export type TaskFilterRouteDependencies = Readonly<{
  readPrincipal(
    env: RuntimeEnvironment,
    cookie: string | null,
    correlationId: string,
  ): Promise<VerifiedSessionPrincipal>;
  readEffectiveAccess(
    env: RuntimeEnvironment,
    principal: VerifiedSessionPrincipal,
  ): Promise<EffectiveAccess>;
  createAdapter(env: RuntimeEnvironment, input: { currentUserId: string }): BitrixAdapter;
  createRepository(env: RuntimeEnvironment): TaskFilterRepository;
}>;

type Variables = { correlationId: string };
const savedFilterIdSchema = z.string().uuid();

function toAuthorizationApiError(error: EffectiveAccessError): ApiHttpError {
  switch (error.kind) {
    case 'forbidden':
      return new ApiHttpError(403, 'FORBIDDEN');
    case 'not_found':
      return new ApiHttpError(404, 'NOT_FOUND');
    case 'upstream_unavailable':
      return new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
  }
}

function mapSavedFilter(row: SavedFilter) {
  const filters = taskFilterListSchema.safeParse(row.filterPayload);
  if (!filters.success) throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
  return savedTaskFilterSchema.parse({
    id: row.id,
    name: row.name,
    revision: row.revision,
    filters: filters.data,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

export function createTaskFilterRoutes(dependencies: TaskFilterRouteDependencies) {
  const routes = new Hono<{ Bindings: RuntimeEnvironment; Variables: Variables }>();

  async function authorize(context: {
    env: RuntimeEnvironment;
    req: { header(name: string): string | undefined };
    get(name: 'correlationId'): string;
  }) {
    const principal = await dependencies.readPrincipal(
      context.env,
      context.req.header('cookie') ?? null,
      context.get('correlationId'),
    );
    try {
      const access = await dependencies.readEffectiveAccess(context.env, principal);
      requirePermission(access, 'app_access');
      return { principal, dataContext: createDataAccessContext(access) };
    } catch (error) {
      if (error instanceof EffectiveAccessError) throw toAuthorizationApiError(error);
      throw error;
    }
  }

  async function loadCatalog(env: RuntimeEnvironment, principal: VerifiedSessionPrincipal) {
    try {
      const adapter = dependencies.createAdapter(env, { currentUserId: principal.userId });
      const result = await adapter.tasks.getFieldCapabilities();
      if (!result.ok) throw toTaskFilterBitrixApiError(result.failure);
      return createTaskFilterCatalog(result.value);
    } catch (error) {
      if (error instanceof ApiHttpError) throw error;
      throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
    }
  }

  async function prepareSavedFilterAccess(context: Parameters<typeof authorize>[0]) {
    const authorization = await authorize(context);
    const repository = dependencies.createRepository(context.env);
    return { ...authorization, repository };
  }

  routes.get('/fields', async (context) => {
    const { principal } = await authorize(context);
    return context.json(await loadCatalog(context.env, principal));
  });

  routes.get('/users', async (context) => {
    const { principal } = await authorize(context);
    const parsed = taskFilterUserSearchRequestSchema.safeParse({
      q: context.req.query('q'),
      cursor: context.req.query('cursor') ?? null,
      pageSize: context.req.query('pageSize') ? Number(context.req.query('pageSize')) : undefined,
    });
    if (!parsed.success) throw new ApiHttpError(400, 'INVALID_REQUEST');

    let result: BitrixResult<EmployeeSearchPage>;
    try {
      const adapter = dependencies.createAdapter(context.env, { currentUserId: principal.userId });
      result = await adapter.users.searchEmployees({
        query: parsed.data.q,
        cursor: parsed.data.cursor,
        pageSize: parsed.data.pageSize,
        departmentId: null,
        includeInactive: false,
      });
      if (!result.ok) throw toTaskFilterBitrixApiError(result.failure);
    } catch (error) {
      if (error instanceof ApiHttpError) throw error;
      throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
    }
    const page = employeeSearchPageSchema.safeParse(result.value);
    if (
      !page.success ||
      page.data.items.length > parsed.data.pageSize ||
      new Set(page.data.items.map((user) => user.id)).size !== page.data.items.length ||
      page.data.items.some((user) => !user.isActive)
    ) {
      throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
    }
    const response = taskFilterUserSearchResponseSchema.safeParse({
      items: page.data.items.map((user) => ({
        id: user.id,
        displayName: user.displayName,
      })),
      nextCursor: page.data.nextCursor,
    });
    if (!response.success) throw new ApiHttpError(503, 'UPSTREAM_UNAVAILABLE');
    return context.json(response.data);
  });

  routes.get('/saved-filters', async (context) => {
    const { dataContext, repository } = await prepareSavedFilterAccess(context);
    try {
      const rows = await repository.listSavedFilters(dataContext);
      return context.json(
        savedTaskFilterListResponseSchema.parse({
          items: rows.map(mapSavedFilter),
        }),
      );
    } catch (error) {
      if (error instanceof ApiHttpError) throw error;
      throwTaskFilterDataApiError(error);
    }
  });

  routes.post('/saved-filters', async (context) => {
    const { principal, dataContext, repository } = await prepareSavedFilterAccess(context);
    const input = await parseJsonBody(context.req.raw, createSavedTaskFilterRequestSchema);
    try {
      const catalog = await loadCatalog(context.env, principal);
      requireValidTaskFilters(input.filters, catalog);
      if (principal.isBitrixAdmin) {
        await repository.ensurePrincipalIdentity(dataContext, principal.displayName);
      }
      const row = await repository.createSavedFilter(dataContext, {
        name: input.name,
        filterPayload: asJson(input.filters),
      });
      return context.json(mapSavedFilter(row), 201);
    } catch (error) {
      if (error instanceof ApiHttpError) throw error;
      if (error instanceof InvalidTaskSearchDefinitionError) {
        throw new ApiHttpError(400, 'INVALID_REQUEST');
      }
      throwTaskFilterDataApiError(error);
    }
  });

  routes.put('/saved-filters/:filterId', async (context) => {
    const { dataContext, repository } = await prepareSavedFilterAccess(context);
    const filterId = savedFilterIdSchema.safeParse(context.req.param('filterId'));
    if (!filterId.success) throw new ApiHttpError(400, 'INVALID_REQUEST');
    const input = await parseJsonBody(context.req.raw, updateSavedTaskFilterRequestSchema);
    try {
      const row = await repository.updateSavedFilter(dataContext, {
        id: filterId.data,
        expectedRevision: input.expectedRevision,
        name: input.name,
      });
      return context.json(mapSavedFilter(row));
    } catch (error) {
      if (error instanceof ApiHttpError) throw error;
      throwTaskFilterDataApiError(error);
    }
  });

  routes.delete('/saved-filters/:filterId', async (context) => {
    const { dataContext, repository } = await prepareSavedFilterAccess(context);
    const filterId = savedFilterIdSchema.safeParse(context.req.param('filterId'));
    if (!filterId.success) throw new ApiHttpError(400, 'INVALID_REQUEST');
    const input = await parseJsonBody(context.req.raw, deleteSavedTaskFilterRequestSchema);
    try {
      await repository.deleteSavedFilter(dataContext, {
        id: filterId.data,
        expectedRevision: input.expectedRevision,
      });
      return context.body(null, 204);
    } catch (error) {
      throwTaskFilterDataApiError(error);
    }
  });

  return routes;
}
