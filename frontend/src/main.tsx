import './index.css';

import { currentAppSurface } from '@/lib/app-surface';

async function startApplication() {
  const root = document.getElementById('root');
  if (!root) throw new Error('Application root is missing.');

  switch (currentAppSurface()) {
    case 'marketing': {
      const { mountMarketingApp } = await import('@/marketing-app');
      mountMarketingApp(root);
      return;
    }
    case 'client': {
      const { mountClientApp } = await import('@/client-app');
      mountClientApp(root);
      return;
    }
    case 'admin': {
      const { mountAdminApp } = await import('@/admin-app');
      mountAdminApp(root);
      return;
    }
    case 'unsupported': {
      root.innerHTML = '<main><h1>AdChecked is unavailable on this hostname.</h1><p>Open <a href="https://adchecked.com">adchecked.com</a> to continue.</p></main>';
      root.className = 'grid min-h-screen place-items-center p-6 text-center [&_main]:grid [&_main]:gap-2 [&_h1]:text-xl [&_h1]:font-semibold [&_p]:text-sm [&_p]:text-muted-foreground [&_a]:underline';
    }
  }
}


void startApplication().catch((error: unknown) => {
  console.error(error);
  const root = document.getElementById('root');
  if (root) {
    root.textContent = 'AdChecked could not start. Refresh the page to try again.';
    root.className = 'grid min-h-screen place-items-center p-6 text-center text-sm';
  }
});
