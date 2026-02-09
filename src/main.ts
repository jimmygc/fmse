import { Buffer } from 'buffer'
(window as any).Buffer = Buffer
import JSONEditor, { EditableNode } from 'jsoneditor';
import { SmartBuffer, SmartBufferOptions } from 'smart-buffer';
import 'jsoneditor/dist/jsoneditor.min.css';
import JSONBig from 'json-bigint';

const JSONbigNative = JSONBig({ useNativeBigInt: true });

const BOOL = 1
const FLOAT = 2
const STR = 3
const DICT = 5
const INT = 6

const TYPE_MAP = {
    "bigint": "INT",
}

class ParseError extends Error { }
const container = document.getElementById("jsoneditor") as HTMLElement;
var origin_data: any = {}

function compare(origin: any, target: any, path: string[], errors: any[]) {
    for (const key in origin) {
        const currentPath = [...path, key];
        const sourceVal = origin[key];
        const targetVal = target[key];
        if (!(key in target)) {
            errors.push({
                path: path,
                message: `Missing ${key}`
            });
        }
        const isSourceLeaf = "VALUE_TYPE" in sourceVal;
        const isTargetLeaf = "VALUE_TYPE" in sourceVal;

        if (!isSourceLeaf) {
            if (!isTargetLeaf) {
                compare(sourceVal, targetVal, currentPath, errors)
            } else {
                errors.push({
                    path: path,
                    message: `Wrong type: should be dict`
                });
            }
        } else {
            if (sourceVal["VALUE_TYPE"] !== targetVal["VALUE_TYPE"]) {
                errors.push({
                    path: currentPath,
                    message: `Wrong VALUE_TYPE: should be ${sourceVal["VALUE_TYPE"]}`
                });
            }
            switch (sourceVal["VALUE_TYPE"]) {
                case BOOL:
                    if (typeof targetVal["VALUE"] != "boolean") {
                        errors.push({
                            path: [...currentPath, "VALUE"],
                            message: `Wrong VALUE_TYPE: should be bool`
                        });
                    }
                    break;
                case FLOAT:
                    if (typeof targetVal["VALUE"] != 'number') {
                        errors.push({
                            path: [...currentPath, "VALUE"],
                            message: `Wrong VALUE_TYPE: should be number`
                        });
                    }
                    break
                case INT:
                    if (!(Number.isInteger(targetVal["VALUE"])) && typeof targetVal["VALUE"] != 'bigint') {
                        if (typeof targetVal["VALUE"] == 'string' && targetVal["VALUE"] != "") {
                            var value = Number(targetVal["VALUE"])
                            if (!isNaN(value) && Number.isInteger(value)) {
                                break;
                            }
                        }
                        errors.push({
                            path: [...currentPath, "VALUE"],
                            message: `Wrong VALUE_TYPE: should be integer`
                        });
                    }
                    break
                case STR:
                    break
                default:
                    errors.push({
                        path: currentPath,
                        message: `Unsupported VALUE_TYPE: ${sourceVal["VALUE_TYPE"]}`
                    });
            }
        }
    }
}

const editor = new JSONEditor(container, {
    mode: 'form', onValidate: (json: any) => {
        const errors: any[] = [];
        if (Object.keys(origin_data).length == 0) {
            return errors;
        }
        if (!("root" in json)) {
            errors.push({
                path: [],
                message: "Missing root"
            });
            return errors
        }
        compare(origin_data["root"], json["root"], ["root"], errors)
        errors.push({
            path: ["k"],
            message: "ERROR"
        });
        return errors;
    }, onEditable: (node) => {
        if (node && (node as EditableNode).path && (node as EditableNode).path.length == 1) {
            return { field: false, value: false }
        }
        if ((node as EditableNode).field == "VALUE_TYPE") {
            return { field: false, value: false }
        }
        return { field: false, value: true }
    }
});


function parse_str(reader: SmartBuffer): string {
    const pad = reader.readUInt8();
    if (pad != 0) {
        throw new ParseError(`Invalid String at ${reader.readOffset}, pad=0x${pad.toString(16)}`);
    }
    const len = reader.readUInt8();
    const buf = reader.readBuffer(len);
    return buf.toString("utf8");
}


function parse_any(reader: SmartBuffer): [string, any] {
    const key = parse_str(reader);
    const t = reader.readInt16LE();
    var value: any = null;
    switch (t) {
        case BOOL:
            var v = reader.readInt8();
            if (v == 1) {
                value = true;
            } else {
                value = false;
            }
            value = { "VALUE": value, "VALUE_TYPE": BOOL };
            break;
        case FLOAT:
            value = { "VALUE": reader.readDoubleLE(), "VALUE_TYPE": FLOAT };
            break;
        case STR:
            value = { "VALUE": parse_str(reader), "VALUE_TYPE": STR };
            break;
        case DICT:
            var len = reader.readInt32LE();
            value = {}
            for (var i = 0; i < len; i++) {
                const [k, v] = parse_any(reader);
                value[k] = v;
            }
            break;
        case INT:
            value = { "VALUE": reader.readBigInt64LE(), "VALUE_TYPE": INT };
            break;
        default:
            throw new ParseError(`Unknown value type: ${t}`)
    }
    return [key, value]
}

function parse(buffer: Buffer) {
    var jsonObj: any = {};
    const reader = SmartBuffer.fromBuffer(buffer);
    jsonObj.ver = reader.readUInt32LE();
    jsonObj.magic = reader.readUInt32LE();
    const root = reader.readUInt8();
    const root_type = reader.readUInt16LE();
    if (root != 0) {
        throw new ParseError(`Invalid root: ${root}`);
    }
    if (root_type != DICT) {
        throw new ParseError(`Invalid root type: ${root_type}`);
    }
    const root_len = reader.readUInt32LE();
    jsonObj["root"] = {};
    for (var i = 0; i < root_len; i++) {
        const [k, v] = parse_any(reader);
        jsonObj["root"][k] = v;
    }
    return jsonObj;
}

var fileInput = document.getElementById('fileInput') as HTMLInputElement
fileInput.addEventListener('change', async (e) => {
    const t = e.target as HTMLInputElement;
    if (!t || !t.files) return;
    const file = t.files[0]
    if (!file) return;
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    try {
        var jsonObj = parse(buffer);
    } catch (err) {
        alert(`Invalid data format ${err}`);
        return;
    }
    origin_data = jsonObj;
    editor.set(jsonObj);
    editor.expandAll();
});

function pack_str(buffer: SmartBuffer, str: string) {
    buffer.writeUInt8(0);
    buffer.writeUInt8(str.length);
    buffer.writeString(str);
}

function pack_any(buffer: SmartBuffer, key: string, value: any) {
    console.log(`key = ${key}`)
    const isLeaf = ("VALUE_TYPE" in value);
    pack_str(buffer, key);
    if (isLeaf) {
        buffer.writeUInt16LE(value["VALUE_TYPE"]);
        switch (value["VALUE_TYPE"]) {
            case BOOL:
                if (value["VALUE"]) {
                    buffer.writeUInt8(1);
                } else {
                    buffer.writeUInt8(0);
                }
                break;
            case FLOAT:
                value = value["VALUE"];
                buffer.writeDoubleLE(value);
                break;
            case STR:
                value = value["VALUE"];
                if (typeof value != "string") {
                    value = value.toString()
                }
                pack_str(buffer, value);
                break;
            case INT:
                value = value["VALUE"];
                console.log(`value=${value}`);
                if (typeof value != "bigint") {
                    value = BigInt(value)
                }
                buffer.writeBigInt64LE(value);
                break;
            default:
                throw new ParseError(`Unknown value type: ${value["VALUE_TYPE"]}`)
        }
    } else {
        const len = Object.keys(value).length
        buffer.writeUInt16LE(DICT);
        buffer.writeUInt32LE(len);
        for (var k in value) {
            pack_any(buffer, k, value[k])
        }
    }
}

function export_as_binary(json: any) {
    var buffer = new SmartBuffer()
    buffer.writeInt32LE(json["ver"]);
    buffer.writeInt32LE(json["magic"]);
    buffer.writeUInt8(0);
    buffer.writeUInt16LE(DICT);
    const root = json["root"];
    const root_len = Object.keys(root).length;
    buffer.writeUInt32LE(root_len);
    for (var key in root) {
        pack_any(buffer, key, root[key])
    }
    return buffer
}

var saveBtn = document.getElementById('saveBtn') as HTMLButtonElement
saveBtn.onclick = async () => {
    const errors = await editor.validate();
    if (errors.length > 0) {
        alert("Please use correct value type");
        return;
    }
    const json = editor.get();
    if (!json || Object.keys(json).length == 0) {
        return;
    }
    const buffer = export_as_binary(json);
    const blob = new Blob([buffer.toBuffer()], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "mod-settings.dat";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
};

