/* jshint esversion: 6 */

// Experimental

var om = om || {};
var protobuf = protobuf || require('./protobuf');

om.ModelFactory = class {

    match(context) {
        const stream = context.stream;
        const signature = [ 0x49, 0x4D, 0x4F, 0x44 ]; // IMOD
        if (stream.length >= signature.length && stream.peek(4).every((value, index) => value === signature[index])) {
            return 'om';
        }
        return undefined;
    }

    open(context) {
        const file = om.File.open(context);
        if (!file.model) {
            throw om.Error('File does not contain a model definition.');
        }
        return context.require('./om-proto').then(() => {
            om.proto = protobuf.get('om').ge.proto;
            try {
                const reader = protobuf.BinaryReader.open(file.model);
                file.model = om.proto.ModelDef.decode(reader);
            }
            catch (error) {
                const message = error && error.message ? error.message : error.toString();
                throw new om.Error('File format is not ge.proto.ModelDef (' + message.replace(/\.$/, '') + ').');
            }
            return om.Metadata.open(context).then((metadata) => {
                return new om.Model(metadata, file);
            });
        });
    }
};

om.Model = class {

    constructor(metadata, file) {
        this._graphs = [];
        for (const graph of file.model.graph) {
            this._graphs.push(new om.Graph(metadata, graph, file.weights));
        }
    }

    get format() {
        return 'DaVinci OM';
    }

    get graphs() {
        return this._graphs;
    }
};

om.Graph = class {

    constructor(metadata, graph, weights, model) {
        this._name = graph.name;
        this._nodes = [];
        this._inputs = [];
        this._outputs = [];
        for (const op of graph.op) {
            if (op.type === 'Const') {
                continue;
            }
            this._nodes.push(new om.Node(metadata, op, graph, weights, model));
        }
    }

    get name() {
        return this._name;
    }

    get groups() {
        return false;
    }

    get nodes() {
        return this._nodes;
    }

    get inputs() {
        return this._inputs;
    }

    get outputs() {
        return this._outputs;
    }

};

om.Node = class {

    constructor(metadata, op, graph, weights) {
        this._name = op.name;
        this._type = metadata.type(op.type) || { name: op.type };
        this._inputs = [];
        this._outputs = [];
        this._attributes = [];
        this._chain = [];
        this._controlDependencies = [];
        this._device = null;
        let inputIdx = 0;
        for (let i = 0; i < op.input.length; i++) {
            if (op.input[i] === '') {
                continue;
            }
            const pos = op.input[i].lastIndexOf(':');
            const name = pos === 0 ? 'internal_unnamed' : op.input[i].slice(0, pos);
            const src_index = op.input[i].slice(pos + 1);
            if (src_index === '-1') {
                this._controlDependencies.push(name);
                continue;
            }
            const inputName = this._type.inputs && i < this._type.inputs.length ? this._type.inputs[i].name : 'input' + (i === 0 ? '' : i.toString());
            const inputNode = graph.op.find(node => node.name === name);
            const format = op.input_desc[inputIdx].layout;
            if (inputNode.type === 'Const') {
                let shape = null;
                const value = inputNode.attr['value'].t;
                if (value.desc.shape != null) {
                    shape = value.desc.shape.dim;
                }
                if ('origin_shape' in value.desc.attr) {
                    shape = value.desc.attr['origin_shape'].list.i;
                }
                let data = null;
                if (value.data.length === 0) {
                    if (weights == null) {
                        data = null;
                    }
                    else if ('merged_offset' in value.desc.attr) {
                        const offset = value.desc.attr['merged_offset'].i;
                        data = weights.slice(offset, offset + value.desc.weight_size);
                    }
                    else {
                        const offset = value.desc.data_offset;
                        data = weights.slice(offset, offset + value.desc.weight_size);
                    }
                }
                else {
                    data = value.data;
                }
                const dataType = om.Utility.dtype(value.desc.dtype);
                const tensorType = new om.TensorType(dataType, shape, format, value.desc.layout);
                const tensor = new om.Tensor('Constant', tensorType, data);
                const argument = new om.Argument(name, null, tensor);
                this._inputs.push(new om.Parameter(inputName, true, [ argument ]));
            }
            else {
                const dataType = op.input_desc[i] ? om.Utility.dtype(op.input_desc[i].dtype) : 'undefined';
                const shape = op.input_desc[inputIdx].shape ? op.input_desc[inputIdx].shape.dim : undefined;
                const tensorType = new om.TensorType(dataType, shape, format, null);
                const identifier = src_index === '0' ? name : name + ':' + src_index;
                const argument = new om.Argument(identifier, tensorType, null);
                this._inputs.push(new om.Parameter(inputName, true, [ argument ]));
            }
            inputIdx++;
        }

        for (let i = 0; i < op.output_desc.length; i++) {
            const outputDesc = op.output_desc[i];
            let shape = outputDesc.shape ? outputDesc.shape.dim : undefined;
            if (op.type === 'Data' || op.type === 'ImageData' || op.type === 'DynamicImageData') {
                shape = outputDesc.shape ? outputDesc.shape.dim : op.input_desc[0].shape.dim;
            }
            const dataType = om.Utility.dtype(outputDesc.dtype);
            const format = outputDesc.layout;
            const tensorType = new om.TensorType(dataType, shape, format);
            const identifier = i === 0 ? this._name : this._name + ':' + i;
            const argument = new om.Argument(identifier, tensorType, null);
            const outputName = this._type.outputs && i < this._type.outputs.length ? this._type.outputs[i].name : 'output' + (i === 0 ? '' : i.toString());
            this._outputs.push(new om.Parameter(outputName, true, [ argument ]));
        }

        for (const attr of Object.entries(op.attr)) {
            const name = attr[0];
            const value = attr[1];
            if (name === 'device') {
                this._device = value;
                continue;
            }
            this._attributes.push(new om.Attribute(metadata.attribute(this._type, name), name, value, true));
        }
    }

    get device() {
        return this._device;
    }

    get name() {
        return this._name || '';
    }

    get type() {
        return this._type;
    }

    get inputs() {
        return this._inputs;
    }

    get outputs() {
        return this._outputs;
    }

    get attributes() {
        return this._attributes;
    }

    get chain() {
        return this._chain;
    }

    get controlDependencies() {
        return this._controlDependencies;
    }
};

om.Attribute = class {

    constructor(metadata, name, value, visible) {
        this._name = name;
        this._value = value;
        this._visible = visible;
        if (Object.prototype.hasOwnProperty.call(value, 'i')) {
            this._value = value.i;
            this._type = 'int64';
        }
        else if (Object.prototype.hasOwnProperty.call(value, 'f')) {
            this._value = value.f;
            this._type = 'float32';
        }
        else if (Object.prototype.hasOwnProperty.call(value, 'b')) {
            this._value = value.b;
            this._type = 'boolean';
        }
        else if (Object.prototype.hasOwnProperty.call(value, 'bt')) {
            this._value = null;
            if (value.bt.length !== 0) {
                this._type = 'tensor';
                this._value = new om.Tensor('Constant', new om.TensorType('float32', [ value.bt.length / 4 ], null), value.bt);
            }
        }
        else if (Object.prototype.hasOwnProperty.call(value, 's')) {
            if (typeof value.s === 'string') {
                this._value = value.s;
            }
            else if (value.s.filter(c => c <= 32 && c >= 128).length === 0) {
                this._value = om.Metadata.textDecoder.decode(value.s);
            }
            else {
                this._value = value.s;
            }
            this._type = 'string';
        }
        else if (Object.prototype.hasOwnProperty.call(value, 'list')) {
            const list = value.list;
            this._value = [];
            if (list.s && list.s.length > 0) {
                this._value = list.s.map(v => String.fromCharCode.apply(null, new Uint16Array(v))).join(', ');
                this._type = 'string[]';
            }
            else if (list.b && list.b.length > 0) {
                this._value = list.b;
                this._type = 'boolean[]';
            }
            else if (list.i && list.i.length > 0) {
                this._value = list.i;
                this._type = 'int64[]';
            }
            else if (list.f && list.f.length > 0) {
                this._value = list.f;
                this._type = 'float32[]';
            }
            else if (list.type && list.type.length > 0) {
                this._type = 'type[]';
                this._value = list.type.map((type) => om.Node.enum2Dtype(type) || '?');
            }
            else if (list.shape && list.shape.length > 0) {
                this._type = 'shape[]';
                this._value = list.shape.map((shape) => new om.TensorShape(shape));
            }
        }
    }

    get name() {
        return this._name;
    }

    get type() {
        return this._type;
    }

    get value() {
        return this._value;
    }

    get visible() {
        return this._visible;
    }
};

om.Parameter = class {

    constructor(name, visible, args) {
        this._name = name;
        this._visible = visible;
        this._arguments = args;
    }

    get name() {
        return this._name;
    }

    get visible() {
        return this._visible;
    }

    get arguments() {
        return this._arguments;
    }
};

om.Argument = class {

    constructor(name, type, initializer) {
        this._name = name;
        this._type = type || null;
        this._initializer = initializer || null;
    }

    get name() {
        return this._name;
    }

    get type() {
        if (this._initializer) {
            return this._initializer.type;
        }
        return this._type;
    }

    get initializer() {
        return this._initializer;
    }
};

om.Tensor = class {

    constructor(kind, type, value) {
        this._type = type;
        this._name = '';
        this._kind = kind;
        this._data = value;
        this._shape = type.shape.dimensions;
    }

    get name() {
        return this._name;
    }

    get type() {
        return this._type;
    }

    get kind() {
        return this._kind;
    }

    set kind(value) {
        this._kind = value;
    }

    get state() {
        return 'Tensor data not implemented.';
    }
};

om.TensorType = class {

    constructor(dtype, shape, format, denotation) {
        this._dtype = dtype;
        this._shape = new om.TensorShape(shape);
        const list = [];
        if (format) {
            list.push(format);
        }
        if (denotation && denotation !== format) {
            list.push(denotation);
        }
        this._denotation = list.join(' ');
    }

    get dataType() {
        return this._dtype;
    }

    set shape(dims) {
        this._shape = dims;
    }

    get shape() {
        return this._shape;
    }

    get denotation() {
        return this._denotation;
    }

    toString() {
        return this.dataType + this._shape.toString();
    }
};

om.TensorShape = class {

    constructor(shape) {
        this._shape = shape;
    }

    get dimensions() {
        return this._shape;
    }

    toString() {
        if (this._shape && Array.isArray(this._shape) && this._shape.length > 0) {
            return '[' + this._shape.map((dim) => dim ? dim.toString() : '?').join(',') + ']';
        }
        return '';
    }
};

om.BinaryReader = class {

    constructor(buffer) {
        this._buffer = buffer;
        this._length = buffer.length;
        this._position = 0;
        this._view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }

    seek(position) {
        this._position = position >= 0 ? position : this._length + position;
    }

    skip(offset) {
        this._position += offset;
    }

    read(length) {
        if (this._position === 0 && length === undefined) {
            this._position = this._length;
            return this._buffer;
        }
        const position = this._position;
        this.skip(length !== undefined ? length : this._length - this._position);
        return this._buffer.subarray(position, this._position);
    }

    byte() {
        const position = this._position;
        this.skip(1);
        return this._buffer[position];
    }

    uint32() {
        const position = this._position;
        this.skip(4);
        return this._view.getUint32(position, true);
    }
};

om.File = class {

    static open(context) {
        const stream = context.stream;
        const buffer = stream.peek();
        const reader = new om.BinaryReader(buffer);
        return new om.File(reader);
    }

    constructor(reader) {
        const decoder = new TextDecoder('utf-8');
        this.header = reader.read(4);
        const size = reader.uint32();
        this.version = reader.uint32();
        this.checksum = reader.read(64);
        reader.skip(4);
        this.is_encrypt = reader.byte();
        this.is_checksum = reader.byte();
        this.type = reader.byte(); // 0=IR model, 1=standard model, 2=OM Tiny model
        this.mode = reader.byte(); // 0=offline, 1=online
        this.name = decoder.decode(reader.read(32));
        this.ops = reader.uint32();
        this.userdefineinfo = reader.read(32);
        this.ir_version = reader.uint32();
        this.model_num = reader.uint32();
        this.platform_version = reader.read(20);
        this.platform_type = reader.byte();
        reader.seek(0);
        reader.skip(size);
        const partitions = new Array(reader.uint32());
        for (let i = 0; i < partitions.length; i++) {
            partitions[i] = {
                type: reader.uint32(),
                offset: reader.uint32(),
                size: reader.uint32()
            };
        }
        const offset = 256 + 4 + 12 * partitions.length;
        for (const partition of partitions) {
            reader.seek(offset + partition.offset);
            const buffer = reader.read(partition.size);
            switch (partition.type) {
                case 0: { // MODEL_DEF
                    this.model = buffer;
                    break;
                }
                case 1: { // MODEL_WEIGHT
                    this.weights = buffer;
                    break;
                }
                case 2: // TASK_INFO
                case 3: // TBE_KERNELS
                case 4: { // CUST_AICPU_KERNELS
                    break;
                }
                case 5: { // DEVICE_CONFIG
                    this.devices = new Map();
                    const decoder = new TextDecoder('ascii');
                    for (let position = 0; position < partition.size; ) {
                        const length = reader.uint32();
                        const name = decoder.decode(reader.read(length));
                        const device = reader.uint32();
                        this.devices.set(name, device);
                        position += 4 + length + 4;
                    }
                    break;
                }
                default: {
                    throw new om.Error("Unknown partition type '" + partition.type + "'.");
                }
            }
        }
    }
};

om.Utility = class {

    static dtype(value) {
        om.Utility._types = om.Utility._types || [
            'undefined', 'float32', 'float16', 'int8', 'uint8', 'int16', 'uint16', 'int32',
            'int64', 'uint32', 'uint64', 'boolean', 'float64', 'string', 'dual_sub_int8', 'dual_sub_uint8',
            'complex64', 'complex128', 'qint8', 'qint16', 'qint32', 'quint8', 'quint16', 'resource',
            'stringref', 'dual', 'variant', 'bfloat16', 'int4', 'uint1', 'int2', 'uint2'
        ];
        if (value < om.Utility._types.length) {
            return om.Utility._types[value];
        }
        throw new om.Error("Unknown dtype '" + value + "'.");
    }
};

om.Metadata = class {

    static open(context) {
        om.Metadata.textDecoder = om.Metadata.textDecoder || new TextDecoder('utf-8');
        if (om.Metadata._metadata) {
            return Promise.resolve(om.Metadata._metadata);
        }
        return context.request('om-metadata.json', 'utf-8', null).then((data) => {
            om.Metadata._metadata = new om.Metadata(data);
            return om.Metadata._metadata;
        }).catch(() => {
            om.Metadata._metadata = new om.Metadata(null);
            return om.Metadata._metadata;
        });
    }

    constructor(data) {
        this._map = new Map();
        this._attributes = new Map();
        if (data) {
            const metadata = JSON.parse(data);
            this._map = new Map(metadata.map((item) => [ item.name, item ]));
        }
    }

    type(name) {
        return this._map.get(name);
    }

    attribute(type, name) {
        const key = type + ':' + name;
        if (!this._attributes.has(key)) {
            const schema = this.type(type);
            if (schema && schema.attributes && schema.attributes.length > 0) {
                for (const attribute of schema.attributes) {
                    this._attributes.set(type + ':' + attribute.name, attribute);
                }
            }
            if (!this._attributes.has(key)) {
                this._attributes.set(key, null);
            }
        }
        return this._attributes.get(key);
    }
};

om.Error = class extends Error {

    constructor(message) {
        super(message);
        this.name = 'Error loading DaVinci model.';
    }
};

if (typeof module !== 'undefined' && typeof module.exports === 'object') {
    module.exports.ModelFactory = om.ModelFactory;
}