import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Pilotfish — an AI agent for each tab',
    description:
      'Open-source AI browser agent. Bring your own OpenAI, Anthropic or OpenRouter key; it fills forms and does tasks in the tab you choose, and shows you where.',
    permissions: ['sidePanel', 'storage', 'tabs', 'scripting', 'debugger', 'unlimitedStorage'],
    host_permissions: ['<all_urls>'],
    action: { default_title: 'Open Pilotfish in this tab' },
    minimum_chrome_version: '116',
  },
});
