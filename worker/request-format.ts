// What a request looks like, apart from who sent it. The change-request guard in index.ts uses these.
// The guard checks the content type only, so each handler still validates the body's shape with zod.
export const isWrite = (method: string) => !['GET', 'HEAD', 'OPTIONS'].includes(method)

export const isJson = (contentType: string | undefined) => contentType?.split(';')[0]?.trim().toLowerCase() === 'application/json'
