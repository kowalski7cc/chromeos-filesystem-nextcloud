export function getWebDAVFileSystemErrorCode(
  error: unknown
): 'NOT_FOUND' | undefined {
  if (!error || typeof error !== 'object') return undefined;

  const httpError = error as {
    status?: unknown
    response?: { status?: unknown }
    message?: unknown
  };
  if (httpError.status === 404 || httpError.response?.status === 404)
    return 'NOT_FOUND';

  if (typeof httpError.message === 'string' &&
    (/^Invalid response:\s*404(?:\s|$)/.test(httpError.message) ||
      httpError.message === 'Request failed with status code 404'))
    return 'NOT_FOUND';

  return undefined;
}
