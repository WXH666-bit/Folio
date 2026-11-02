export interface DockerConnection { command:string;prefix:string[];kind:"direct"|"wsl";label:string; }
export function connectionFor(mode:string,platform:string,hasDocker:boolean,distro?:string):DockerConnection;
export function dockerConnection():Promise<DockerConnection>;
export function dockerInvocation(args:string[],connection:DockerConnection):{command:string;args:string[]};
export function dockerRun(args:string[],timeout?:number):Promise<string>;
export function dockerPath(file:string,connection?:DockerConnection):Promise<string>;
export function holdDockerHost():Promise<{close():void}>;
export function mappedHostDataPath(file:string,localData?:string,hostData?:string):string|undefined;
