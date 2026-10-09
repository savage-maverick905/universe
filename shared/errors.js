export class HttpError extends Error {
  constructor(status, message, code = null, headers = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}
export const badRequest = (m, code = 'bad_request') => new HttpError(400, m, code);
export const forbidden = (m = 'You do not have permission to do that') => new HttpError(403, m, 'forbidden');
export const notFound = (m = 'Not found') => new HttpError(404, m, 'not_found');
export const conflict = (m, code = 'conflict') => new HttpError(409, m, code);
