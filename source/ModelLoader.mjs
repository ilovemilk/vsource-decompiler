import { VVDFile, BSPFile, VPKFile, MDLFile, VMTFile, VTFFile, VTXFile } from '../index.mjs';

import chalk from 'chalk';
import path from 'path';
import fs from 'fs';
import Zip from 'node-zip';

if(fs.existsSync('filesystem.log')) {
    fs.unlinkSync('filesystem.log');
}
const logFile = fs.createWriteStream('filesystem.log');

class VirtualFileSystem {

    static indexFileTree(dir, filelist) {
        filelist = filelist || {};

        const files = fs.readdirSync(dir);
        
        files.forEach(file => {
            if (fs.statSync(dir + "/" + file).isDirectory()) {
                filelist = this.indexFileTree(dir + '/' + file, filelist);
            } else {
                const dirPath = dir.split(/\/|\\/g).slice(1);
                const fileKey = dirPath.join("/") + "/" + file.toLocaleLowerCase();

                logFile.write(fileKey + '\n');

                filelist[fileKey] = { 
                    file: dir + '/' + file, 
                    async arrayBuffer() {
                        return new Promise((resolve, reject) => {
                            fs.readFile(dir + '/' + file, (err, data) => {
                                if(err) {
                                    reject(new Error('Error loading file: ' + err));
                                } else {
                                    resolve(data);
                                }
                            });
                        })
                    }
                }
            }
        });

        return filelist;
    }

    constructor(root = "csgo/") {
        this.root = root;
        this.pakfile = null;
        this.indexed = false;
        this.fileRegistry = {};
    }

    attatchPakfile(pakfileBuffer) {
        const pakfile = new Zip(pakfileBuffer);
        this.pakfile = pakfile;

        const entries = Object.keys(pakfile.files);

        for(let entry of entries) {
            logFile.write(entry + '\n');

            this.fileRegistry[entry] = { 
                file: entry, 
                async arrayBuffer() {
                    return pakfile.files[entry].asNodeBuffer();
                }
            };
        }
    }

    getFile(resource) {
        resource = resource.replace(/\/|\\/g, "/").toLocaleLowerCase();

        return new Promise(async (resolve, reject) => {

            // index if not yet indexed
            if(!this.indexed) {
                this.fileRegistry = Object.assign(VirtualFileSystem.indexFileTree(this.root), this.fileRegistry);
                this.indexed = true;
            }

            // look in fileregistry
            const fileSystemEntries = Object.keys(this.fileRegistry);

            for(let entry of fileSystemEntries) {
                if(entry.match(resource)) {
                    resolve(this.fileRegistry[entry]);
                    break;
                }
            }

            reject(new Error('Resource File not found: ' + resource));
        })
    }

}

const fileSystem = new VirtualFileSystem();
const propTypes = new Map();

export class Model {

    static get resourceRoot() {
        return fileSystem.root;
    }

    static set resourceRoot(val) {
        fileSystem.root = val;
    }

    constructor() {
        this.geometry = new Set();
    }
    
    registerProp(prop) {
        if(!propTypes.has(prop.PropType)) {
            propTypes.set(prop.PropType, {
                name: prop.PropType,
                mdlPath: prop.PropType,
                vvdPath: prop.PropType.replace('.mdl', '.vvd'),
                listeners: [],
            });
        }
    }

    async loadMap(mapName) {
        this.name = mapName;

        const mapPath = `maps/${mapName}.bsp`;
        log('Loading map', mapPath);

        const map = await fileSystem.getFile(mapPath).then(async res => {

            const bsp = BSPFile.fromDataArray(await res.arrayBuffer());
            const mesh = bsp.convertToMesh();

            log('Reading pakfile.');
            fileSystem.attatchPakfile(Buffer.from(bsp.pakfile.buffer));

            log('Load map textures...');
            const textures = await this.loadMapTextures(bsp.textures);
            log('Map textures loaded.');

            return { 
                mesh, 
                bsp, 
                textures
            };
        })

        // world
        const mesh = map.mesh;
        const textures = map.textures;

        const materials = [...textures.keys()].map(key => {
            return textures.get(key);
        });

        this.geometry.add({
            name: mapName,
            vertecies: mesh.vertecies.map(vert => ([
                vert.vertex[0], vert.vertex[1], vert.vertex[2],
                vert.uv[0], vert.uv[1], vert.uv[2],
                vert.normal[0], vert.normal[1], vert.normal[2]
            ])).flat(),
            indecies: mesh.indecies,
            materials: materials,
            scale: [1, 1, 1],
            origin: [0, 0, 0],
            position: [0, 0, 0],
            rotation: [0, 0, 0],
        });

        log('Load map props...');

        await this.loadMapProps(map.bsp.gamelumps.sprp);

        log('Done loading map props.');
    }

    async loadMapTextures(textureArray) {
        return new Promise(async (resolve, reject) => {
            const textures = new Map();
            
            for(let texture of textureArray) {

                const resPath = `${texture.toLocaleLowerCase()}.vmt`;
                await fileSystem.getFile(resPath).then(async vmtFile => {
                    const vmt = VMTFile.fromDataArray(await vmtFile.arrayBuffer());

                    if(vmt && vmt.data.lightmappedgeneric) {
                        const materialTexture = vmt.data.lightmappedgeneric['$basetexture'];
    
                        if(materialTexture) {
                            const resPath = `${materialTexture.toLocaleLowerCase()}.vtf`;
                            await fileSystem.getFile(resPath).then(async res => {
                                const vtf = VTFFile.fromDataArray(await res.arrayBuffer());
                                vtf.name = materialTexture.toLocaleLowerCase().replace(/\\|\//g, "/");
                                textures.set(texture, vtf);
                            }).catch(err => console.error('Missing map texture ' + resPath));
                        }
                    }
                    if(vmt && vmt.data.worldvertextransition) {
                        const materialTexture = vmt.data.worldvertextransition['$basetexture'];
    
                        if(materialTexture) {
                            const resPath = `${materialTexture.toLocaleLowerCase()}.vtf`;
                            await fileSystem.getFile(resPath).then(async res => {
                                const vtf = VTFFile.fromDataArray(await res.arrayBuffer());
                                vtf.name = materialTexture.toLocaleLowerCase().replace(/\\|\//g, "/");
                                textures.set(texture, vtf);
                            }).catch(err => console.error('Missing map texture ' + resPath));
                        }
                    }

                    // want to check if texture loaded correctly? check with "!textures.has(texture)"
                }).catch(err => {
                    console.error(err);
                })
            }

            resolve(textures);
        })
    }

    async loadMapProps(props) {
        return new Promise((resolve, reject) => {
            // collect all different types of props
            for(let prop of props) {

                if(!prop.PropType) {
                    throw new Error('Error decompiling prop gamelump.');
                    continue;
                }

                this.registerProp(prop);
                const type = propTypes.get(prop.PropType);

                const propGeometry = {
                    name: type.name,
                    materials: [],
                    scale: [
                        prop.UniformScale || 1, 
                        prop.UniformScale || 1, 
                        prop.UniformScale || 1
                    ],
                    origin: [0, 0, 0],
                    position: [
                        -prop.Origin.data[0].data,
                        prop.Origin.data[2].data,
                        prop.Origin.data[1].data,
                    ],
                    rotation: [
                        -prop.Angles.data[2].data * Math.PI / 180,
                        prop.Angles.data[1].data * Math.PI / 180,
                        prop.Angles.data[0].data * Math.PI / 180,
                    ],
                };

                type.listeners.push(propData => {
                    propGeometry.materials = propData.textures;
                    propGeometry.vertecies = propData.vertecies.flat();
                    propGeometry.indecies = propData.indecies;
                    this.geometry.add(propGeometry);
                });
            }

            // load all different types once
            let propCounter = 0;

            for(let [_, propType] of propTypes) {

                this.loadProp(propType).then(p => {
                    for(let listener of propType.listeners) listener(p);
                    
                }).catch(err => {
                    console.log('');
                    error(chalk.red('Failed to load prop: ' + propType.mdlPath));
                    log(err);
                    console.log('');
                    
                }).finally(() => {
                    propCounter++;

                    process.stdout.cursorTo(0);
                    process.stdout.write(`[INFO] Loading props ${propCounter.toString()} / ${propTypes.size.toString()}`);
                    
                    if(propCounter == propTypes.size) {
                        resolve();
                        process.stdout.write(`\n`);
                    }
                })
            }
        })
    }

    async loadProp(propType) {
        const prop = {
            materials: [],
            textures: []
        };

        // mdl
        const mdlFile = await fileSystem.getFile(propType.mdlPath);
        const mdl = MDLFile.fromDataArray(await mdlFile.arrayBuffer());

        // textures and materials
        for(let tex of mdl.textures) {
            const texPath = tex.path;

            if(texPath == undefined) {
                continue;
            }

            const vmtFile = await fileSystem.getFile(`${texPath}.vmt`);
            const vmt = VMTFile.fromDataArray(await vmtFile.arrayBuffer());
            // not used right now:
            // prop.materials.push(vmt);
    
            const vtfFile = await fileSystem.getFile(`${texPath}.vtf`);
            const vtf = VTFFile.fromDataArray(await vtfFile.arrayBuffer());
            vtf.name = texPath;
            prop.textures.push(vtf);
        }

        // geometry info
        const vvdFile = await fileSystem.getFile(propType.vvdPath);
        const vvd = VVDFile.fromDataArray(await vvdFile.arrayBuffer());
        const vertecies = vvd.convertToMesh();

        const vtxFile = await fileSystem.getFile(propType.vvdPath.replace('.vvd', '.dx90.vtx'));
        const vtx = VTXFile.fromDataArray(await vtxFile.arrayBuffer());

        const realVertecies = vtx.vertexIndecies;
        const realIndecies = vtx.indecies;

        prop.vertecies = realVertecies.map(rv => vertecies[rv]);
        prop.indecies = realIndecies;

        return prop;
    }

    static loadVPK(vpkPath) {
        const load = async () => {
            const vpkFetch = await fileSystem.getFile(vpkPath);
            const vpkData = await vpkFetch.arrayBuffer();
            const vpk = VPKFile.fromDataArray(vpkData);
            return vpk;
        }
        return load();
    }
}
