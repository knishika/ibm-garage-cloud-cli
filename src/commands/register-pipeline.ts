import {Container} from 'typescript-ioc';
import {Arguments, Argv} from 'yargs';
import * as chalk from 'chalk';

import {CommandLineOptions} from '../model';
import {DefaultOptionBuilder} from '../util/yargs-support';
import {
  isPipelineError,
  PipelineErrorType,
  RegisterJenkinsPipelineImpl,
  RegisterPipeline,
  RegisterPipelineOptions,
  RegisterTektonPipeline
} from '../services/register-pipeline';
import {checkKubeconfig} from '../util/kubernetes';
import {ErrorSeverity, isCommandError} from '../util/errors';
import {QuestionBuilder} from '../util/question-builder';
import {isClusterConfigNotFound} from '../util/cluster-type';

export const command = 'pipeline [gitUrl]';
export const desc = 'Register a pipeline for the current code repository';
export const builder = (yargs: Argv<any>) => new DefaultOptionBuilder<RegisterPipelineOptions>(yargs)
  .quiet()
  .debug()
  .build()
  .positional('gitUrl', {
    description: 'Provides the git url for the repository that should be registered in the pipeline. The branch can be added by appending `#{branch-name}`, If not provided the git url will be read from the current directory',
    type: 'string',
    demandOption: false,
  })
  .option('templateNamespace', {
    type: 'string',
    alias: 't',
    describe: 'the namespace where Jenkins is running or the template Tekton pipelines have been installed',
  })
  .option('pipelineNamespace', {
    type: 'string',
    alias: 'n',
    describe: 'the namespace where the pipeline should be deployed',
  })
  .option('skipWebhook', {
    type: 'boolean',
    describe: 'flag indicating that the webhook should not be created'
  })
  .option('username', {
    alias: 'u',
    description: 'username used to access the git repository'
  })
  .option('password', {
    alias: 'P',
    description: 'the password or personal access token used to access the git repository'
  })
  .option('values', {
    description: 'optional file with additional values to add to the secret'
  })
  .option('replaceGitSecret', {
    alias: 'g',
    description: 'Flag indicating that the secret holding the git credentials should be recreated',
    type: 'boolean'
  })
  .option('tekton', {
    conflicts: 'jenkins',
    description: 'register a tekton pipeline',
    type: 'boolean',
  })
  .option('jenkins', {
    conflicts: 'tekton',
    description: 'register a jenkins pipeline',
    type: 'boolean',
  })
  .option('pipeline', {
    description: 'the name of the Tekton pipeline to use',
    type: 'string',
  })
  .option('generateCrumb', {
    alias: 'c',
    description: 'flag indicating that a crumb is required to complete the registration',
    default: true,
  })
  .option('param', {
    alias: 'p',
    type: 'array',
    description: 'Key-value parameters to set in the pipeline config (e.g. scan-image=true)',
    demandOption: false,
    default: [],
  });
exports.handler = async (argv: Arguments<RegisterPipelineOptions & CommandLineOptions & {jenkins: boolean, tekton: boolean}> & {param?: string[]}) => {
  let spinner;

  if (argv.debug) {
    console.log('Input values: ', argv);
  }

  function statusCallback(status: string) {
    // if (!spinner) {
    //   spinner = ora(status).start();
    // } else {
    //   spinner.text = status;
    // }
    console.log(status);
  }

  const pipelineParams = argv.param.reduce(
    (result: object, currentValue: string) => {
      if (currentValue.indexOf('=') > -1) {
        const regex = /(.*)=(.*)/;
        const key = currentValue.replace(regex, '$1');
        const value = currentValue.replace(regex, '$2');

        result[key] = value;
      }

      return result;
    },
    {});

  try {
    await checkKubeconfig();

    if (!argv.jenkins && !argv.tekton) {
      const questionBuilder: QuestionBuilder<{pipelineType: 'jenkins' | 'tekton'}> = Container.get(QuestionBuilder);

      const {pipelineType} = await questionBuilder.question({
        type: 'list',
        name: 'pipelineType',
        message: 'Select the type of pipeline that should be run?',
        choices: [{
          name: 'Jenkins',
          value: 'jenkins'
        }, {
          name: 'Tekton',
          value: 'tekton'
        }]
      }).prompt();

      if (pipelineType === 'jenkins') {
        argv.jenkins = true;
      } else {
        argv.tekton = true;
      }
    }

    const command: RegisterPipeline = argv.tekton
      ? Container.get(RegisterTektonPipeline)
      : Container.get(RegisterJenkinsPipelineImpl);

    await command.registerPipeline(Object.assign({}, argv, {pipelineParams}), statusCallback);

    if (spinner) {
      spinner.stop();
    }

    process.exit(0);
  } catch (err) {
    if (spinner) {
      spinner.stop();
    }

    if (isClusterConfigNotFound(err)) {
      console.log(chalk.red(`Cluster configuration not found in the namespace - ${err.namespace}/${err.configMapName}`));
      console.log('It looks like the namespace needs to be set up for development by running ' + chalk.yellow(`${argv.$0} sync ${err.namespace} --dev`));
      process.exit(1);
    } else if (isCommandError(err)) {
      if (err.type.severity === ErrorSeverity.WARNING) {
        console.log(`${chalk.yellow('Warning:')} ${err.message}`);
        process.exit(0)
      } else {
        console.log(`${err.type.severity}: ${err.message}`);
        process.exit(1);
      }
    } else if (isPipelineError(err)) {
      if (err.pipelineErrorType === PipelineErrorType.JENKINS_MISSING) {
        console.log(chalk.red('Jenkins has not been installed in this namespace'));
        console.log();
      } else if (err.pipelineErrorType === PipelineErrorType.NAMESPACE_MISSING) {
        console.log(chalk.red('The target namespace does not exist'));

        console.log(`Create the namespace by running: ${chalk.yellow('igc namespace ' + argv.pipelineNamespace + ' --dev')}`);
        console.log();
      } else if (err.pipelineErrorType === PipelineErrorType.NO_PIPELINE_NAMESPACE) {
        console.log(chalk.red('The target namespace is not provided'));

        console.log(`Provide the namespace by passing it with ${chalk.yellow('-n')} flag`);
        if (err.clusterType === 'openshift') {
          console.log(`  or by setting the namespace in the current context - e.g. ${chalk.yellow('oc project {project}')}`);
        }
        console.log();
      }
    } else {
      console.log('Error registering pipeline:', err.message);
      if (argv.debug) {
        console.log('Error registering pipeline:', err);
      }
      process.exit(1);
    }
  }
};
