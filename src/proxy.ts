const USER_AGENT = 'Nextcloud (unofficial) for Chrome OS';
const RULE_ID_BASE = 100000;
const MAX_PROXY_HOSTS = 2500;
const RULES_PER_HOST = 2;
const OPTIONAL_HEADERS = new Set([
  'origin',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
]);

export default class Proxy {
  async register(host: string) {
    const rules = await this.#getRules();
    const hosts = rules
      .filter(rule => this.#isManagedRule(rule.id) && rule.id % 2 === 0)
      .map(rule => new URL(rule.condition.urlFilter.slice(1)).host);
    await this.reconcile([...hosts, host]);
  }

  async reconcile(hosts: string[]) {
    const requestedHosts = Array.from(new Set(hosts.map(normalizeHost))).sort();
    const normalizedHosts = (await Promise.all(requestedHosts.map(async host =>
      await browser.permissions.contains({ origins: [`https://${host}/*`] }) ? host : undefined
    ))).filter((host): host is string => host !== undefined);
    if (normalizedHosts.length > MAX_PROXY_HOSTS)
      throw new Error('Too many WebDAV hosts are mounted');

    const currentRules = await this.#getRules();
    const removeRuleIds = currentRules
      .filter(rule => this.#isManagedRule(rule.id))
      .map(rule => rule.id);
    const addRules = normalizedHosts.flatMap((host, index) => {
      const ruleId = RULE_ID_BASE + index * RULES_PER_HOST;
      const condition = {
        urlFilter: `|https://${host}/`,
        initiatorDomains: [browser.runtime.id],
        resourceTypes: ['xmlhttprequest'],
      };

      return [
        {
          id: ruleId,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'user-agent', operation: 'set', value: USER_AGENT },
              { header: 'cookie', operation: 'remove' },
              { header: 'origin', operation: 'remove' },
              { header: 'sec-fetch-site', operation: 'remove' },
              { header: 'sec-fetch-mode', operation: 'remove' },
              { header: 'sec-fetch-dest', operation: 'remove' },
            ],
          },
          condition,
        },
        {
          id: ruleId + 1,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            responseHeaders: [
              { header: 'set-cookie', operation: 'remove' },
            ],
          },
          condition,
        },
      ];
    });

    const dnr = (chrome as any).declarativeNetRequest;
    try {
      await dnr.updateDynamicRules({ removeRuleIds, addRules });
    } catch (error) {
      const fallbackRules = addRules.map((rule: any) => {
        if (!rule.action.requestHeaders) return rule;
        return {
          ...rule,
          action: {
            ...rule.action,
            requestHeaders: rule.action.requestHeaders.filter(
              (header: any) => !OPTIONAL_HEADERS.has(header.header)
            ),
          },
        };
      });
      if (fallbackRules.length === 0 || fallbackRules.every(
        (rule: any, index: number) => rule === addRules[index]
      )) throw error;

      console.warn('Chrome rejected optional WebDAV header rules; retrying without them', error);
      await dnr.updateDynamicRules({ removeRuleIds, addRules: fallbackRules });
    }
  }

  #getRules = async (): Promise<any[]> => {
    return (chrome as any).declarativeNetRequest.getDynamicRules();
  };

  #isManagedRule = (ruleId: number) => {
    return ruleId >= RULE_ID_BASE &&
      ruleId < RULE_ID_BASE + MAX_PROXY_HOSTS * RULES_PER_HOST;
  };
}

function normalizeHost(host: string) {
  const url = new URL(host.includes('://') ? host : `https://${host}`);
  if (url.protocol !== 'https:' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash)
    throw new Error('Enter a valid HTTPS server domain');
  return url.host;
}
