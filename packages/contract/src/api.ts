// The HTTP API between the web app and the server. Handlers live in @posthub/api.
// Every path sits under /rpc, which the dev server proxies to the API.
import { Context, Schema } from 'effect';
import { Multipart } from 'effect/http';
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
} from 'effect/http-api';
import {
  Account,
  EditableStatus,
  MediaHostSettings,
  MediaItem,
  OAuthProviderId,
  Platform,
  Post,
  Provider,
  QueueSettings,
  User,
  WordPressCategory,
} from './domain';
import { ApiErrors, BadRequest, Unauthorized } from './errors';

/** Files can be up to 1 GB: plenty for a local machine. */
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

/** The signed-in owner, provided to endpoints by `Authorization`. */
export class CurrentUser extends Context.Service<CurrentUser, User>()(
  '@posthub/contract/CurrentUser',
) {}

/** Resolves the session cookie to the signed-in owner, or fails with Unauthorized. */
export class Authorization extends HttpApiMiddleware.Service<
  Authorization,
  { provides: CurrentUser }
>()('@posthub/contract/Authorization', { error: Unauthorized }) {}

/** Turns invalid input into a BadRequest whose message says what is wrong. */
export class InputValidation extends HttpApiMiddleware.Service<InputValidation>()(
  '@posthub/contract/InputValidation',
  { error: BadRequest },
) {}

const Id = Schema.Struct({ id: Schema.String });
const TargetId = Schema.Struct({ targetId: Schema.String });

/** A list response (mutable, like the arrays the web app works with). */
const List = <S extends Schema.Top>(item: S) => Schema.mutable(Schema.Array(item));

const bounded = (max: number) => Schema.String.check(Schema.isMaxLength(max));
/** Not blank. The server trims it. */
const required = (max: number) =>
  bounded(max).check(Schema.isPattern(/\S/, { message: 'This field is required.' }));
const HttpUrl = bounded(2000).check(
  Schema.makeFilter(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'Enter a valid http(s) URL.' },
  ),
);

/** Input constraints stay separate from stored options so older posts remain readable. */
const WordPressOptionsInput = Schema.Struct({
  tags: Schema.mutable(
    Schema.Array(
      Schema.String.check(
        Schema.makeFilter((tag) => tag.trim().length > 0 && tag.trim().length <= 100, {
          message: 'Tags must contain between 1 and 100 characters.',
        }),
      ),
    ).check(Schema.isMaxLength(50)),
  ),
  categories: Schema.Record(
    Schema.String,
    Schema.mutable(
      Schema.Array(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))).check(
        Schema.isMaxLength(100),
      ),
    ),
  ),
});

/** Fields the composer can set. Targets and timestamps are server-owned. */
export const PostFields = Schema.Struct({
  title: required(200),
  /** Editor HTML. */
  body: bounded(100_000),
  link: Schema.NullOr(HttpUrl),
  status: EditableStatus,
  scheduledAt: Schema.NullOr(Schema.Date),
  accountIds: Schema.mutable(Schema.Array(Schema.String).check(Schema.isMaxLength(50))),
  mediaIds: Schema.mutable(Schema.Array(Schema.String).check(Schema.isMaxLength(20))),
  featuredMediaId: Schema.NullOr(Schema.String),
  thumbnailMediaId: Schema.NullOr(Schema.String),
  wordpressOptions: Schema.NullOr(WordPressOptionsInput),
});
export type PostFields = typeof PostFields.Type;

const optionalFields = {
  body: Schema.optionalKey(PostFields.fields.body),
  link: Schema.optionalKey(PostFields.fields.link),
  status: Schema.optionalKey(PostFields.fields.status),
  scheduledAt: Schema.optionalKey(PostFields.fields.scheduledAt),
  accountIds: Schema.optionalKey(PostFields.fields.accountIds),
  mediaIds: Schema.optionalKey(PostFields.fields.mediaIds),
  featuredMediaId: Schema.optionalKey(PostFields.fields.featuredMediaId),
  thumbnailMediaId: Schema.optionalKey(PostFields.fields.thumbnailMediaId),
  wordpressOptions: Schema.optionalKey(PostFields.fields.wordpressOptions),
};

/** The client supplies the id so TanStack DB can insert optimistically. */
export const CreatePost = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  title: PostFields.fields.title,
  ...optionalFields,
});

export const PostChanges = Schema.Struct({
  title: Schema.optionalKey(PostFields.fields.title),
  ...optionalFields,
});
export type PostChanges = typeof PostChanges.Type;

export class SystemApi extends HttpApiGroup.make('system', { topLevel: true })
  .add(
    HttpApiEndpoint.get('health', '/health', {
      success: Schema.Struct({ ok: Schema.Boolean, time: Schema.Date }),
    }),
    HttpApiEndpoint.get('platforms', '/platforms', { success: List(Platform) }),
    HttpApiEndpoint.get('me', '/me', { success: User }).middleware(Authorization),
  )
  .prefix('/rpc') {}

export class PostsApi extends HttpApiGroup.make('posts')
  .add(
    HttpApiEndpoint.get('list', '/', { success: List(Post), error: ApiErrors }),
    HttpApiEndpoint.post('create', '/', { payload: CreatePost, success: Post, error: ApiErrors }),
    HttpApiEndpoint.post('update', '/update', {
      payload: Schema.Struct({ id: Schema.String, changes: PostChanges }),
      success: Post,
      error: ApiErrors,
    }),
    HttpApiEndpoint.post('delete', '/delete', { payload: Id, success: Id, error: ApiErrors }),
    /** Queue a failed target again. The publisher picks it up on its next pass. */
    HttpApiEndpoint.post('retry', '/retry', { payload: TargetId, success: Post, error: ApiErrors }),
    /** Schedules the post at the next free queue slot. Fails with Conflict when there is none. */
    HttpApiEndpoint.post('enqueue', '/enqueue', {
      payload: Schema.Struct({ postId: Schema.String }),
      success: Post,
      error: ApiErrors,
    }),
    /** The owner posted a manual-handoff target (TikTok) themselves. */
    HttpApiEndpoint.post('markPosted', '/mark-posted', {
      payload: Schema.Struct({ targetId: Schema.String, url: Schema.optionalKey(HttpUrl) }),
      success: Post,
      error: ApiErrors,
    }),
  )
  .middleware(Authorization)
  .prefix('/rpc/posts') {}

export class MediaApi extends HttpApiGroup.make('media')
  .add(
    HttpApiEndpoint.get('list', '/', { success: List(MediaItem), error: ApiErrors }),
    HttpApiEndpoint.post('upload', '/upload', {
      payload: HttpApiSchema.asMultipart({ maxFileSize: MAX_UPLOAD_BYTES })(
        Schema.Struct({ file: Multipart.SingleFileSchema }),
      ),
      success: MediaItem,
      error: ApiErrors,
    }),
    HttpApiEndpoint.post('delete', '/delete', { payload: Id, success: Id, error: ApiErrors }),
  )
  .middleware(Authorization)
  .prefix('/rpc/media') {}

export class AccountsApi extends HttpApiGroup.make('accounts')
  .add(
    HttpApiEndpoint.get('list', '/', { success: List(Account), error: ApiErrors }),
    HttpApiEndpoint.get('providers', '/providers', {
      success: List(Provider),
      error: ApiErrors,
    }),
    HttpApiEndpoint.post('connectWordPress', '/wordpress', {
      payload: Schema.Struct({
        siteUrl: required(2000),
        username: required(200),
        appPassword: required(200),
      }),
      success: Schema.Struct({ displayName: Schema.String }),
      error: ApiErrors,
    }),
    /** Categories on a connected WordPress site, for the composer. */
    HttpApiEndpoint.get('wordpressCategories', '/wordpress-categories', {
      payload: { accountId: Schema.String },
      success: List(WordPressCategory),
      error: ApiErrors,
    }),
    HttpApiEndpoint.post('disconnect', '/disconnect', {
      payload: Id,
      success: Id,
      error: ApiErrors,
    }),
  )
  .middleware(Authorization)
  .prefix('/rpc/accounts') {}

const ProviderPayload = Schema.Struct({ provider: OAuthProviderId });

export class ProviderAppsApi extends HttpApiGroup.make('providerApps')
  .add(
    HttpApiEndpoint.post('save', '/save', {
      payload: Schema.Struct({
        provider: OAuthProviderId,
        clientId: required(500),
        /** Leave empty to keep the current secret. */
        clientSecret: Schema.optionalKey(bounded(500)),
      }),
      success: ProviderPayload,
      error: ApiErrors,
    }),
    HttpApiEndpoint.post('remove', '/remove', {
      payload: ProviderPayload,
      success: ProviderPayload,
      error: ApiErrors,
    }),
  )
  .middleware(Authorization)
  .prefix('/rpc/provider-apps') {}

/** The media host form. Leave the secret empty to keep the current one. */
export const MediaHostInput = Schema.Struct({
  endpoint: HttpUrl,
  region: required(100),
  bucket: required(200),
  accessKeyId: required(500),
  secretAccessKey: Schema.optionalKey(bounded(500)),
  publicBaseUrl: Schema.optionalKey(Schema.NullOr(HttpUrl)),
});
export type MediaHostInput = typeof MediaHostInput.Type;

const Ok = Schema.Struct({ ok: Schema.Boolean });

export class SettingsApi extends HttpApiGroup.make('settings')
  .add(
    HttpApiEndpoint.get('mediaHost', '/media-host', {
      success: Schema.NullOr(MediaHostSettings),
      error: ApiErrors,
    }),
    HttpApiEndpoint.post('saveMediaHost', '/media-host', {
      payload: MediaHostInput,
      success: MediaHostSettings,
      error: ApiErrors,
    }),
    HttpApiEndpoint.post('removeMediaHost', '/media-host/remove', {
      success: Ok,
      error: ApiErrors,
    }),
    /** Uploads a tiny file with these settings, downloads it anonymously and deletes it. */
    HttpApiEndpoint.post('testMediaHost', '/media-host/test', {
      payload: MediaHostInput,
      success: Ok,
      error: ApiErrors,
    }),
  )
  .middleware(Authorization)
  .prefix('/rpc/settings') {}

export class QueueApi extends HttpApiGroup.make('queue')
  .add(
    HttpApiEndpoint.get('slots', '/slots', { success: QueueSettings, error: ApiErrors }),
    /** Replaces every slot (and the time zone they are in). */
    HttpApiEndpoint.post('saveSlots', '/slots', {
      payload: Schema.Struct({
        timezone: QueueSettings.fields.timezone,
        slots: QueueSettings.fields.slots.check(Schema.isMaxLength(200)),
      }),
      success: QueueSettings,
      error: ApiErrors,
    }),
    /** The next slot no scheduled post has yet, or null. */
    HttpApiEndpoint.get('nextSlot', '/next', {
      success: Schema.Struct({ at: Schema.NullOr(Schema.Date) }),
      error: ApiErrors,
    }),
  )
  .middleware(Authorization)
  .prefix('/rpc/queue') {}

export class Api extends HttpApi.make('posthub')
  .add(SystemApi)
  .add(PostsApi)
  .add(MediaApi)
  .add(AccountsApi)
  .add(ProviderAppsApi)
  .add(SettingsApi)
  .add(QueueApi)
  .middleware(InputValidation) {}
