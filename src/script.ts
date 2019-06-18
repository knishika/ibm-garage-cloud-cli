#!/usr/bin/env node

import {scriptName} from 'yargs';

import {defineBuildImageCommand} from './commands/build-image/define-command';
import {defineDeployImageCommand} from './commands/deploy-image/define-command';
import {defineGenerateTokenCommand} from './commands/generate-token/define-command';
import {defineRegisterPipelineCommand} from './commands/register-pipeline/define-command';
import {defineLaunchToolsCommand} from './commands/launch-tools/define-command';
import {defineGetVlanCommand} from './commands/vlan/define-command';
import {defineJenkinsAuth} from './commands/jenkins-auth/define-command';
import {defineCreateWebhookCommand} from './commands/create-webhook/define-command';

scriptName('igc')
  .usage('IBM Garage Cloud cli')
  .usage('')
  .usage('Usage: $0 <command> [args]')
  .command(defineJenkinsAuth(
    'jenkins-auth',
  ))
  .command(defineGenerateTokenCommand(
    'gen-token'
  ))
  .command(defineRegisterPipelineCommand(
    'register',
  ))
  .command(defineCreateWebhookCommand(
    'git-webhook',
  ))
  .command(defineBuildImageCommand(
    'build',
  ))
  .command(defineDeployImageCommand(
    'deploy',
  ))
  .command(defineLaunchToolsCommand(
    'tools',
  ))
  .command(defineGetVlanCommand(
    'vlan',
  ))
  .demandCommand()
  .help()
  .argv;
