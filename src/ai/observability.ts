import { Langfuse } from 'langfuse';

function createNoopLangfuse() {
  const noopSpan = () => ({
    update: () => undefined,
    end: () => undefined,
    span: noopSpan,
  });
  return {
    trace: () => ({
      span: noopSpan,
      update: () => undefined,
      end: () => undefined,
    }),
    generation: () => ({
      end: () => undefined,
    }),
    shutdownAsync: async () => undefined,
    on: () => undefined,
  };
}

const hasKeys = !!process.env.LANGFUSE_SECRET_KEY && !!process.env.LANGFUSE_PUBLIC_KEY;
const langfuse = hasKeys
  ? new Langfuse({
      secretKey: process.env.LANGFUSE_SECRET_KEY!,
      publicKey: process.env.LANGFUSE_PUBLIC_KEY!,
      baseUrl: process.env.LANGFUSE_BASEURL || 'https://us.cloud.langfuse.com',
      release: process.env.LANGFUSE_RELEASE || 'dev-release',
      requestTimeout: 10000,
    })
  : createNoopLangfuse();

if ('on' in langfuse) {
  langfuse.on('error', error => {
    process.stderr.write(`Langfuse error: ${error}\n`);
  });
}

export default langfuse;
