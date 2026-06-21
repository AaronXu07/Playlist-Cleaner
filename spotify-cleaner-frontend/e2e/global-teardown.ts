import { stopMockServer } from './mock-server';

export default async function globalTeardown() {
  await stopMockServer();
}
