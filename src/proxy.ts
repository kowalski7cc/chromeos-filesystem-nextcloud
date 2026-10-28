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

interface ProxyHost {
  host: string
  useHttps?: boolean
}

export default class Proxy {
  async register(host: string, useHttps = true) {
    const rules = await this.#getRules();
    const hosts: ProxyHost[] = rules
      .filter(rule => this.#isManagedRule(rule.id) && rule.id % 2 === 0)
      .map(rule => {
        const url = new URL(rule.condition.urlFilter.slice(1));
        return { host: url.host, useHttps: url.protocol === 'https:' };
      });
    await this.reconcile([...hosts, { host, useHttps }]);
  }

  async reconcile(hosts: Array<string | ProxyHost>) {
    const requestedHosts = Array.from(new Map(hosts.map(normalizeHost).map(server => [
      `${server.useHttps ? 'https' : 'http'}://${server.host}`,
      server,
    ])).values()).sort((left, right) => {
      const leftOrigin = `${left.useHttps ? 'https' : 'http'}://${left.host}`;
      const rightOrigin = `${right.useHttps ? 'https' : 'http'}://${right.host}`;
      return leftOrigin.localeCompare(rightOrigin);
    });
    const normalizedHosts = (await Promise.all(requestedHosts.map(async server => {
      const protocol = server.useHttps ? 'https' : 'http';
      return await browser.permissions.contains({
        origins: [`${protocol}://${server.host}/*`],
      }) ? server : undefined;
    }))).filter((server): server is ProxyHost & { useHttps: boolean } =>
      server !== undefined
    );
    if (normalizedHosts.length > MAX_PROXY_HOSTS)
      throw new Error('Too many WebDAV hosts are mounted');

    const currentRules = await this.#getRules();
    const removeRuleIds = currentRules
      .filter(rule => this.#isManagedRule(rule.id))
      .map(rule => rule.id);
    const addRules = normalizedHosts.flatMap(({ host, useHttps }, index) => {
      const ruleId = RULE_ID_BASE + index * RULES_PER_HOST;
      const protocol = useHttps ? 'https' : 'http';
      const condition = {
        urlFilter: `|${protocol}://${host}/`,
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

function normalizeHost(input: string | ProxyHost) {
  const useHttps = typeof input === 'string' || input.useHttps === undefined
    ? true
    : input.useHttps;
  const protocol = useHttps ? 'https:' : 'http:';
  const host = typeof input === 'string' ? input : input.host;
  const url = new URL(host.includes('://') ? host : `${protocol}//${host}`);
  if (url.protocol !== protocol || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash)
    throw new Error('Enter a valid server address');
  return { host: url.host, useHttps };
}
