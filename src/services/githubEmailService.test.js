const { fetchVerifiedEmails } = require('./githubEmailService');

const jsonResponse = (body, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body
});

describe('githubEmailService.fetchVerifiedEmails', () => {
  it('maps verified/primary flags from the provider list', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse([
        { email: 'Secondary@Example.com', primary: false, verified: true },
        { email: 'owner@example.com', primary: true, verified: true },
        { email: 'old@example.com', primary: false, verified: false }
      ])
    );

    const result = await fetchVerifiedEmails('token-123', { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      { value: 'secondary@example.com', primary: false, verified: true },
      { value: 'owner@example.com', primary: true, verified: true },
      { value: 'old@example.com', primary: false, verified: false }
    ]);
  });

  it('sends the bearer token and the GitHub accept header', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse([]));

    await fetchVerifiedEmails('abc', { fetchImpl });

    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.github.com/user/emails');
    expect(options.headers.Authorization).toBe('Bearer abc');
    expect(options.headers.Accept).toBe('application/vnd.github+json');
  });

  it('returns null when the provider rejects the token', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ message: 'Bad credentials' }, false, 401));

    await expect(fetchVerifiedEmails('expired', { fetchImpl })).resolves.toBeNull();
  });

  it('returns null on a network failure instead of throwing', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(fetchVerifiedEmails('abc', { fetchImpl })).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it('drops entries without a usable address', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse([{ email: 'ok@example.com', verified: true }, { email: '' }, { verified: true }, null])
    );

    await expect(fetchVerifiedEmails('abc', { fetchImpl })).resolves.toEqual([
      { value: 'ok@example.com', primary: false, verified: true }
    ]);
  });

  it('returns null when no token is supplied', async () => {
    const fetchImpl = jest.fn();
    await expect(fetchVerifiedEmails('', { fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
