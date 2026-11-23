import { setupServer } from 'msw/node';

import { handlers } from './handlers';

/**
 * The network for every test (testing skill: mock the network with MSW, never the API client). Tests add or override
 * endpoints with `server.use(...)`; a request nothing handles fails the test (`onUnhandledRequest: 'error'`).
 */
export const server = setupServer(...handlers);
