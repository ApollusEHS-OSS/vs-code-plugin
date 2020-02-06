import * as vscode from 'vscode';
import { fileURLToPath } from 'url';
import * as path from 'path';
import * as fs from 'fs';
import * as ps from 'ps-node';
import * as child_process from 'child_process';
import * as events from 'events';
import * as os from 'os';
// import { addons } from '@storybook/addons';

export function activate(context: vscode.ExtensionContext) {
	let currentPanel : vscode.WebviewPanel | undefined = undefined;

	//define PORT and host variables to feed the webview content from SB server
	let PORT : number;
	let host : string = 'localhost';
	
	const aesopEmitter = new events.EventEmitter();

	const platform = os.platform();
	const commands = {
		linux: {
			cmd: 'netstat',
			args: ['-apntu'],
		},
		darwin: {
			cmd: 'netstat',
			args: ['-v', '-n', '-p', 'tcp'],
		},
		win32: {
			cmd: 'netstat.exe',
			args: ['-a', '-n', '-o'],
		},
	};
		
	const command = commands[platform];

	//set context "aesop-awake" to true; enabling views
	vscode.commands.executeCommand("setContext", "aesop-awake", true);

	//create the status bar to let the user know what Aesop is doing
	const statusText = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 7);
	statusText.text = "Aesop is finding your Storybook dependency..."
	statusText.color = "#FFFFFF";
	statusText.command = undefined;
	statusText.tooltip = "Aesop status";
	
	//create disposable to register Aesop Awaken command to subscriptions
	let disposable : vscode.Disposable = vscode.commands.registerCommand('extension.aesopAwaken', () => {

		//declare variable to toggle whether a running SB process was found
		let foundSb = false;

		//declare a variable to toggle whether running Node processes have been checked
		let checkedProcesses = false;

		//define a path to the user's root working directory
		const rootDir = fileURLToPath(vscode.workspace.workspaceFolders[0].uri.toString(true));
		
		//reveal status text with default message
		statusText.show();

		//first test whether Storybook has been depended into your application
		fs.access(path.join(rootDir, '/node_modules/@storybook'), (err) => {
			//if the filepath isn't found, show the user what Aesop is reading as the root path
			if (err) {
				vscode.window.showErrorMessage(`Aesop could not find Storybook as a dependency in the active folder, ${rootDir}`);
				throw new Error('Error finding a storybook project')
			}	else {
				statusText.text = "Aesop found a Storybook project.";

				//check to see if a storybook node process is already running
				ps.lookup({
					command: 'node',
					psargs: 'ux'
				}, (err : Error, resultList : any) => {
					if (err){
						vscode.window.showErrorMessage(`Failed looking for running Node processes. Error: ${err}`);
						statusText.dispose();
						throw new Error('Failed looking for running Node processes.');
					} else {
						//notify the user that Aesop is checking for a running Storybook instances
						statusText.text = `Reviewing Node processes...`;

						//if the process lookup was able to find running processes, iterate through to review them
						resultList.forEach((nodeProcess) => {
							//check if any running processes are Storybook processes
							//stretch feature: check for multiple instances of storybook and reconcile
							if ((nodeProcess.arguments[0].includes('node_modules')) && (nodeProcess.arguments[0].includes('storybook'))) {

								//set foundSb to true to prevent Aesop from running another process
								foundSb = true;
								
								//once port is known, fire event emitter to instantiate webview
								statusText.text = `Retrieving running Storybook process...`;

								//grab the process id to use netstat in the else condition
								const nodeProcessPid = parseInt(nodeProcess['pid']).toString();

								//dynamically retrieve port with netstat
								const netStatProcess = child_process.spawn(command.cmd, command.args);
								const grepProcess = child_process.spawn('grep', [nodeProcessPid]);

								netStatProcess.stdout.pipe(grepProcess.stdin);
								grepProcess.stdout.setEncoding('utf8');
								
								grepProcess.stdout.on('data', (data) => {
									const parts = data.split(/\s/).filter(String);
									const partIndex = (platform === 'win32') ? 1 : 3;
									PORT = parseInt(parts[partIndex].replace(/[^0-9]/g, ''));
								});

								process.on('message', (message) => {
									switch (message.type) {
										case 'killNet':
											netStatProcess.kill();
											break;
										case 'killGrep':
											grepProcess.kill();
											break;
										default:
											console.log(message);
									}
								});

								netStatProcess.stdout.on('exit', (code) =>{
									vscode.window.showInformationMessage(`Netstat ended with ${code}`);
								});

								grepProcess.stdout.on('exit', (code) =>{
									vscode.window.showInformationMessage(`Grep ended with ${code}`);
								});

								process.send({type: 'killNet'});
								process.send({type: 'killGrep'});

								aesopEmitter.emit('sb_on');
							}//---> close if process.arguments[0] contains storybook
						})//---> close resultList.forEach()
						checkedProcesses = true;
					}
				});

				//if no processes matched 'storybook', we will have to spin up the storybook server
				if (checkedProcesses === true && foundSb === false){
					//starts by checking for/extracting any port flags from the SB script in the package.json
					fs.readFile(path.join(rootDir, 'package.json'), (err, data) => {
						if (err){
							vscode.window.showErrorMessage(`Aesop is attempting to read ${rootDir}. Is there a package.json file here?`);
							statusText.dispose();
						}	else {
							statusText.text = `Checking package.json...`;

							//enter the package.JSON file and retrieve its contents as an object
							let packageJSON = JSON.parse(data.toString());
							let storybookScript = packageJSON.scripts.storybook;
								
							//iterate through the text string (stored on "storybook" key) and parse out port flag
							//it is more helpful to split it into an array separated by whitespace to grab this
							let retrievedScriptArray = storybookScript.split(' ');
								
							//@TODO if script already includes --ci, no need to add it

							//older Windows systems support here: check platform, change process command accordingly
							let platform : NodeJS.Platform = os.platform();

							const sbCLI = './node_modules/.bin/start-storybook'
							const sbStartIndex = retrievedScriptArray.indexOf('start-storybook')
							retrievedScriptArray[sbStartIndex] = sbCLI;
							retrievedScriptArray.push('--ci');
								
							//now launch the child process on the port you've derived
							const childProcessArguments = (platform === 'win32') ? ['run', 'storybook'] : retrievedScriptArray;
							const childProcessCommand = (platform === 'win32') ? 'npm.cmd' : 'node';
							
							const runSb = child_process.spawn(childProcessCommand, childProcessArguments, {cwd: rootDir, detached: false, env: process.env, windowsHide: false, windowsVerbatimArguments: true });

							statusText.text = `Done looking. Aesop will now launch Storybook in the background.`;
							runSb.stdout.setEncoding('utf8');
							let counter = 0;

							//Storybook outputs three messages to the terminal as it spins up
							//grab the port from the last message to listen in on the process

							runSb.stdout.on('data', (data) => {
								// if (emittedAesop === true) return;
								let str = data.toString().split(" ");
								counter += 1;
									
								if (counter >= 2) {
									for (let i = 165; i < str.length; i += 1){
										if(str[i].includes('localhost')) {
											const path = str[i];
											const regExp = (/[^0-9]/g);
											PORT = (path.replace(regExp, ""));
											// emittedAesop = true;
											aesopEmitter.emit('sb_on');
											break;
										}
									}
								}
							});

							runSb.on('error', (err) => {
								console.log(err);
								process.exit(1);
							});

							//make sure the child process is terminated on process exit
							runSb.on('exit', (code) => {
								console.log(`child process exited with code ${code}`);
							});
						} //close fs readfile else clause
					}) //close fs readfile block
				} //close IF checked true, found false
			} //close fs.access else clause
		});

		aesopEmitter.on('sb_on', () => {
			createAesop(PORT, host);
		});
	
		function createAesop(PORT, host){
			statusText.hide();
			vscode.window.showInformationMessage(`Welcome to Aesop Storybook`);

			//ADDED: if/else clause to check if Aesop has already been instantiated
			if (currentPanel) {
				currentPanel.reveal(vscode.ViewColumn.Beside);
			} else {
				currentPanel = vscode.window.createWebviewPanel(
					'aesop-sb',
					'Aesop',
					vscode.ViewColumn.Beside,
					{
						enableCommandUris: true,
						enableScripts: true,
						portMapping: [{
							webviewPort: PORT,
							extensionHostPort: PORT
						}],
						localResourceRoots: [vscode.Uri.file(context.extensionPath)],
					}
				);

				currentPanel.webview.html = `
				<!DOCTYPE html>
				<html lang="en">
					<head>
						<meta charset="UTF-8">
						<meta name="viewport" content="width=device-width, initial-scale=1.0">
						<title>Aesop</title>
						<style>
							html { width: 100%; height: 100%; min-width: 20%; min-height: 20%;}
							body { display: flex; flex-flow: column nowrap; padding: 0; margin: 0; width: 100%' justify-content: center}
						</style>
					</head>
					<body>
						<script>
							const vscode = acquireVsCodeApi();
							const currentState = vscode.getState() || { value: 0 };
							console.log(\`\$\{currentState\}\`);

							window.addEventListener('message', event => {
								const message = event.data;
								console.log("message received: ", message);
								vscode.postMessage(message);
							});

						</script>
						<iframe src="http://${host}:${PORT}" width="100%" height="600"></iframe>
						<div id="attackRoot"></div>
					</body>
				</html>`
			} // close if/else check for "currentPanel"

			currentPanel.webview.onDidReceiveMessage((message) => {
				vscode.window.showInformationMessage(message);
			});

			currentPanel.onDidDispose(
				(e) => {
					currentPanel = undefined;
				},
				undefined,
				context.subscriptions
			);
		} // close createAesop helper function
	}); //close disposable

	context.subscriptions.push(disposable);
}

export function deactivate() {
	process.exit();
}
