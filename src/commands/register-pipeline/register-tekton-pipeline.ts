import {Inject} from 'typescript-ioc';

import {CreateGitSecret, GitParams} from '../git-secret';
import {Namespace} from '../namespace';
import {KubeTektonPipelineResource, TektonPipelineResource} from '../../api/kubectl/tekton-pipeline-resource';
import {KubeBody} from '../../api/kubectl/kubernetes-resource-manager';
import {ConfigMap, KubeConfigMap} from '../../api/kubectl';
import {RegisterPipeline, RegisterPipelineOptions} from './index';
import {KubeTektonPipelineRun} from '../../api/kubectl/tekton-pipeline-run';
import {KubeTektonPipeline, TektonPipeline} from '../../api/kubectl/tekton-pipeline';
import {QuestionBuilder, QuestionBuilderImpl} from '../../util/question-builder';
import inquirer, {objects} from 'inquirer';
import ChoiceOption = inquirer.objects.ChoiceOption;
import {CreateServiceAccount} from '../create-service-account/create-service-account';

const noopNotifyStatus = (test: string) => undefined;

export interface TektonPipelineOptions {
    pipelineNamespace?: string;
    templateNamespace?: string;
}

export interface IBMCloudConfig {
    CLUSTER_TYPE: string;
    APIURL: string;
    SERVER_URL: string;
    RESOURCE_GROUP: string;
    REGISTRY_URL: string;
    REGISTRY_NAMESPACE: string;
    REGION: string;
    CLUSTER_NAME: string;
    INGRESS_SUBDOMAIN: string;
    TLS_SECRET_NAME: string;
}

export class RegisterTektonPipeline implements RegisterPipeline {
    @Inject
    createGitSecret: CreateGitSecret;
    @Inject
    namespaceBuilder: Namespace;
    @Inject
    pipelineResource: KubeTektonPipelineResource;
    @Inject
    pipelineRun: KubeTektonPipelineRun;
    @Inject
    pipeline: KubeTektonPipeline;
    @Inject
    configMap: KubeConfigMap;
    @Inject
    serviceAccount: CreateServiceAccount;

    async registerPipeline(options: RegisterPipelineOptions, notifyStatus: (text: string) => void = noopNotifyStatus) {
        notifyStatus('Getting git parameters');
        const gitParams: GitParams = await this.createGitSecret.getGitParameters(options);

        notifyStatus(`Setting up ${options.pipelineNamespace} namespace`);
        await this.setupNamespace(options.pipelineNamespace, options.templateNamespace, notifyStatus);

        const serviceAccount = 'pipeline';
        notifyStatus(`Creating ${serviceAccount} service account`);
        await this.createServiceAccount(options.pipelineNamespace, serviceAccount, notifyStatus);

        notifyStatus('Creating Git PipelineResource');
        const gitSource = await this.createGitPipelineResource(options, gitParams);

        notifyStatus('Creating Image PipelineResource');
        const dockerImage = await this.createImagePipelineResource(options, gitParams);

        const pipelineName = await this.getPipelineName(options.pipelineNamespace, options.pipelineName);

        if (pipelineName !== 'none') {
            notifyStatus(`Creating PipelineRun for pipeline: ${pipelineName}`);
            await this.createPipelineRun({
                name: gitParams.repo,
                gitSource,
                dockerImage,
                pipelineName,
                pipelineNamespace: options.pipelineNamespace,
                serviceAccount
            });
        }
    }

    async setupNamespace(toNamespace: string, fromNamespace: string, notifyStatus: (text: string) => void) {
        if (toNamespace === fromNamespace) {
            return;
        }

        await this.namespaceBuilder.create(toNamespace, fromNamespace, notifyStatus);
    }

    async createServiceAccount(namespace: string, name: string, notifyStatus: (text: string) => void): Promise<string> {

        await this.serviceAccount.create(namespace, name, ['privileged'], ['edit']);

        return name;
    }

    async createGitPipelineResource({pipelineNamespace = 'dev'}: TektonPipelineOptions, gitParams: GitParams): Promise<string> {
        const name = `${gitParams.repo}-git`;

        const gitResourceParams = {
            url: gitParams.url,
            revision: gitParams.branch,
            username: gitParams.username,
            password: gitParams.password,
        };

        await this.pipelineResource.createOrUpdate(
          name,
          this.buildGitPipelineResourceBody(name, gitResourceParams),
          pipelineNamespace
        );

        return name;
    }

    buildGitPipelineResourceBody(name: string, gitParams: {url: string, revision: string, username?: string, password?: string}): KubeBody<TektonPipelineResource> {

        const params = Object.keys(gitParams)
          .filter(key => !!gitParams[key])
          .map(key => ({
              name: key,
              value: gitParams[key],
          }));

        return {
            body: {
                metadata: {
                    name,
                },
                spec: {
                    type: 'git',
                    params,
                }
            }
        }
    }

    async createImagePipelineResource({pipelineNamespace = 'dev', templateNamespace = 'tools'}: TektonPipelineOptions, params: {repo: string}): Promise<string> {
        const name = `${params.repo}-image`;
        const imageUrl: string = await this.buildImageUrl({pipelineNamespace, templateNamespace}, params);

        await this.pipelineResource.createOrUpdate(
          name,
          this.buildImagePipelineResourceBody(name, imageUrl),
          pipelineNamespace
        );

        return name;
    }

    async buildImageUrl(options: TektonPipelineOptions, params: {repo: string}): Promise<string> {

        const containerConfig: ConfigMap<IBMCloudConfig> = await this.configMap.get('ibmcloud-config', options.templateNamespace);
        if (!containerConfig || !containerConfig.data) {
            throw new Error('Unable to retrieve config map: ibmcloud-config');
        }

        const registryUrl = containerConfig.data.REGISTRY_URL;
        // Not sure of pipelineNamespace is the right default...
        const registryNamespace = containerConfig.data.REGISTRY_NAMESPACE || options.pipelineNamespace;

        return `${registryUrl}/${registryNamespace}/${params.repo}:latest`;
    }

    buildImagePipelineResourceBody(name: string, url: string): KubeBody<TektonPipelineResource> {
        return {
            body: {
                metadata: {
                    name,
                },
                spec: {
                    type: 'image',
                    params: [
                        {
                            name: 'url',
                            value: url,
                        }
                    ],
                },
            },
        };
    }

    async getPipelineName(namespace: string, pipelineName?: string): Promise<string> {
        const pipelines: TektonPipeline[] = await this.pipeline.list({namespace});

        const pipelineChoices: Array<ChoiceOption<{pipelineName: string}>> = pipelines
          .map(pipeline => pipeline.metadata.name)
          .map(name => ({name, value: name}));

        if (pipelineChoices.length === 0) {
            console.log(`No Pipelines found in ${namespace} namespace. Skipping PipelineRun creation`);
            return 'none';
        }

        const questionBuilder: QuestionBuilder<{pipelineName: string}> = new QuestionBuilderImpl()
          .question({
              type: 'list',
              choices: pipelineChoices.concat({name: 'Skip PipelineRun creation', value: 'none'}),
              name: 'pipelineName',
              message: 'Select the Pipeline to use in the PipelineRun:',
          }, pipelineName);

        return questionBuilder.prompt()
          .then(result => result.pipelineName);
    }

    async createPipelineRun(
      {
          pipelineNamespace,
          name,
          gitSource,
          dockerImage,
          pipelineName,
          serviceAccount
      }: {
          pipelineNamespace: string,
          name: string,
          gitSource: string,
          dockerImage: string,
          pipelineName: string,
          serviceAccount: string
      }) {
        const dateHex = Date.now().toString(16);
        const pipelineRunName = `${name}-run-${dateHex}`;

        return this.pipelineRun.create(
          pipelineRunName,
          {
              body: {
                  metadata: {
                      name: pipelineRunName,
                      labels: {
                          app: name,
                      },
                  },
                  spec: {
                    pipelineRef: {
                        name: pipelineName,
                    },
                    resources: [
                        {
                            name: 'git-source',
                            resourceRef: {
                                name: gitSource,
                            },
                        },
                        {
                            name: 'docker-image',
                            resourceRef: {
                                name: dockerImage,
                            },
                        },
                    ],
                    serviceAccount,
                },
              }
          },
          pipelineNamespace,
        );
    }
}