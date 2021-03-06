import {get, post, Response} from 'superagent';

import {CreateWebhook, GitApi, GitEvent, GitHeader, UnknownWebhookError, WebhookAlreadyExists} from './git.api';
import {TypedGitRepoConfig} from './git.model';
import {GitBase} from './git.base';
import {isResponseError} from '../../util/superagent-support';
import {GitHookConfig} from '../../services/git-secret';
import fs from 'fs';
import path from 'path';

export interface GitHookData {
  name: 'web';
  active: boolean;
  events: GithubEvent[];
  config: GitHookConfig;
}

enum GithubHeader {
  event = 'X-GitHub-Event'
}

enum GithubEvent {
  push = 'push',
  pullRequest = 'pull_request'
}

enum GitHookUrlVerification {
  performed = '0',
  notPerformed = '1'
}

interface Tree {
  path: string;
  mode: string;
  type: 'blob' | 'tree';
  size?: number;
  sha: string;
  url: string;
}

interface TreeResponse {
  sha: string;
  url: string;
  tree: Tree[];
  truncated?: boolean;
}

interface FileResponse {
  content: string;
  encoding: 'base64';
  url: string;
  sha: string;
  size: number;
  node_id: string;
}

interface RepoResponse {
  default_branch: string;
}

abstract class GithubCommon extends GitBase implements GitApi {
  constructor(config: TypedGitRepoConfig) {
    super(config);
  }

  abstract getBaseUrl(): string;

  async listFiles(): Promise<Array<{path: string, url?: string, contents?: string}>> {
    const response: Response = await this.get(`/git/trees/${this.config.branch}`);

    const treeResponse: TreeResponse = response.body;

    return treeResponse.tree.filter(tree => tree.type === 'blob');
  }

  async getFileContents(fileDescriptor: {path: string, url?: string}): Promise<string | Buffer> {
    const response: Response = await this.get(fileDescriptor.url);

    const fileResponse: FileResponse = response.body;

    return new Buffer(fileResponse.content, fileResponse.encoding);
  }

  async getDefaultBranch(): Promise<string> {
    const response: Response = await this.get();

    const treeResponse: RepoResponse = response.body;

    return treeResponse.default_branch;
  }

  async createWebhook(options: CreateWebhook): Promise<string> {

    try {
      const response: Response = await this.post('/hooks', this.buildWebhookData(options));

      return response.body.id;
    } catch (err) {
      if (isResponseError(err)) {
        if (err.response.text.match(/Hook already exists/)) {
          throw new WebhookAlreadyExists('Webhook already exists on repository', err);
        } else {
          throw new UnknownWebhookError('Unknown error creating webhook', err);
        }
      } else {
        throw new UnknownWebhookError(err.message, err);
      }
    }
  }

  getRefPath(): string {
    return 'body.ref';
  }

  getRef(): string {
    return `refs/heads/${this.config.branch}`;
  }

  getRevisionPath(): string {
    return 'body.head_commit.id';
  }

  getRepositoryUrlPath(): string {
    return 'body.repository.url';
  }

  getRepositoryNamePath(): string {
    return 'body.repository.full_name';
  }

  getHeader(headerId: GitHeader): string {
    return GithubHeader[headerId];
  }

  getEventName(eventId: GitEvent): string {
    return GithubEvent[eventId];
  }

  async get(uri: string = ''): Promise<Response> {
    const url: string = uri.startsWith('http') ? uri : this.getBaseUrl() + uri;

    return get(url)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json');
  }

  async post(uri: string, data: any): Promise<Response> {
    return post(this.getBaseUrl() + uri)
      .auth(this.config.username, this.config.password)
      .set('User-Agent', `${this.config.username} via ibm-garage-cloud cli`)
      .accept('application/vnd.github.v3+json')
      .send(data);
  }

  buildWebhookData({jenkinsUrl, webhookUrl}: {jenkinsUrl?: string, webhookUrl?: string}): GitHookData {
    const url = webhookUrl ? webhookUrl : `${jenkinsUrl}/github-webhook/`;

    const pushGitHook: GitHookData = {
      name: 'web',
      events: [GithubEvent.push],
      active: true,
      config: {
        url,
        content_type: 'json',
        insecure_ssl: GitHookUrlVerification.performed,
      }
    };

    return pushGitHook;
  }
}

export class Github extends GithubCommon {
  constructor(config: TypedGitRepoConfig) {
    super(config);
  }

  getBaseUrl(): string {
    return `https://api.github.com/repos/${this.config.owner}/${this.config.repo}`;
  }
}

export class GithubEnterprise extends GithubCommon {
  constructor(config: TypedGitRepoConfig) {
    super(config);
  }

  getBaseUrl(): string {
    return `${this.config.protocol}://${this.config.host}/api/v3/repos/${this.config.owner}/${this.config.repo}`;
  }
}
