(function(global) {
"use strict";

var
slice       = Array.prototype.slice,
indentityFn = function(x){ return x };

function Suspender(timeout) {
    this.id       = Suspender.num++;
    this.runner   = null;
    this.released = false;
    this.timeout  = isNaN(timeout) ? -1 : timeout;
}

Suspender.num = 0;

Suspender.prototype = {

    isReleased: function() {
        return this.released;
    },

    bind: function(runner) {
        var me = this;

        if (me.runner || me.isReleased()) {
            throw 'This suspender has been already binded';
        }

        me.runner = runner;

        if (me.timeout > -1) {
            setTimeout(function(){ me.release() }, me.timeout);
        }
    },

    release: function(withValue) {
        var runner;

        if (this.runner) {            
            this.released  = true;
            runner         = this.runner;
            this.runner    = null;

            setTimeout(function(){ runner.runNext(withValue) }, 0);
        }
    },

    pushToArray: function(array) {
        array.push(this);
        return this;
    }
}

Suspender.releaseAll = function(array, withValue) {
    while (array.length) {
        array.shift().release(withValue);
    }
}

// Runner
function Runner(generator) {
    this.id           = Runner.num++;
    this.routineState = void 0;
    this.generator    = generator;
    this.routine      = void 0;
    this.forever      = false;
    this.args         = void 0;
    this.updateState(Runner.SUSPENDED);
}

Runner.num       = 0;
Runner.SUSPENDED = 0;
Runner.RUNNING   = 1;
Runner.DONE      = 2;
Runner.FAIL      = 3;

Runner.prototype = {

    debug: true,

    errorHandler: function(){ },

    catch: function(errorHandler) {
        this.errorHandler = errorHandler;
    },

    done: indentityFn,

    isSuspended: function() {
        return this.routineState.value instanceof Suspender && !this.routineState.value.isReleased();
    },

    run: function() {
        var me = this;
        this.args         = arguments;
        this.routineState = { done: false, value: void 0 };
        this.routine      = this.generator.apply({}, this.args);
        
        setTimeout(function(){
            me.updateState(Runner.RUNNING);
            me.runNext();    
        }, 0);
    },

    runNext: function(withValue) {
        var value,
        me = this;

        if (me.isSuspended()) { return }

        if (me.debug) {
            me.routineState = me.routine.next(withValue);    
        } else {
            try {
                me.routineState = me.routine.next(withValue);
            } catch (e) {
                this.updateState(Runner.FAIL);
                me.errorHandler(e);
                if (this.forever) {
                    return me.run(this.args);
                }
                return;
            }
        }
        
        value = me.routineState.value;
        if (value instanceof Suspender) {
            this.updateState(Runner.SUSPENDED);
            value.bind(me);
            return;
        }

        if (! me.routineState.done) {
            this.updateState(Runner.RUNNING);
            me.runNext(value);
        } else if (this.forever) {
            me.run.apply(me, this.args);
        } else {
            this.updateState(Runner.DONE);
            this.done(value);
        }
    },

    fork: function() {
        var
        runner = new Runner(this.generator);
        runner.forever = this.forever;
        return runner;
    },

    updateState: function(state) {
        if (this.state !== state) {
            this.state = state;
            return true;
        }
        return false;
    }
}


function Buffer(size) {
    this.id    = Buffer.num++;
    this.size  = isNaN(size) ? 1 : size;
    this.array = [];
}

Buffer.num = 0;

Buffer.prototype = {

    shift: function() {
        return this.array.shift();
    },

    push: function(value) {
        if (this.isFull()) { return false }
        this.array.push(value);
        return true;
    },

    isFull: function() {
        return !(this.array.length < this.size);
    },

    isEmpty: function() {
        return this.array.length === 0;
    }
}

function Channel(buffer) {
    this.id                 = Channel.num++;
    this.buffer             = buffer;
    this.closed             = false;
    this.data               = void 0;
    this.senderSuspenders   = [];
    this.receiverSuspenders = [];
}

Channel.num = 0;

Channel.prototype = {

    encode : indentityFn,
    decode : indentityFn,

    receive: function() {
        var data;

        // is unbuffered
        if (! this.buffer) {
            if (this.data !== void 0) {
                if (this.senderSuspenders[0]) {
                    this.senderSuspenders.shift().release();
                }
                data      = this.data;
                this.data = void 0;
                return this.decode(data);
            } else {
                return (new Suspender()).pushToArray(this.receiverSuspenders);
            }
        }

        // if buffered
        if (this.buffer.isEmpty()) {
            return (new Suspender()).pushToArray(this.receiverSuspenders);
        } else {            
            if (this.senderSuspenders[0]) {
                this.senderSuspenders.shift().release();
            }
            return this.decode(this.buffer.shift());
        }
    },

    send: function(data) {
        if (this.closed) { throw 'closed channel' }

        // is unbuffered
        if (! this.buffer) {
            if (this.data !== void 0) {
                if (this.receiverSuspenders[0]) {                    
                    this.receiverSuspenders.shift().release(this.data);
                }
            } else {
                if (this.receiverSuspenders[0]) {
                    this.data = void 0;
                    this.receiverSuspenders.shift().release(this.decode(this.encode(data)));                    
                    return new Suspender(0);
                }
            }
            this.data = this.encode(data);
            return (new Suspender()).pushToArray(this.senderSuspenders);
        }

        // if buffered        
        if (! this.buffer.isFull()) {
            this.buffer.push(this.encode(data));
            if (this.receiverSuspenders[0]) {
                this.receiverSuspenders.shift().release(this.decode(this.buffer.shift()));
            }
        }

        if (this.buffer.isFull()) {
            return (new Suspender()).pushToArray(this.senderSuspenders);
        }
    },

    close: function() {
        this.closed           = true;
        this.senderSuspenders = [];
        Suspender.releaseAll(this.receiverSuspenders);
    }
}

// SignalChannel
function SignalChannel(wait) {
    this.id                 = Channel.num++;
    this.closed             = false;
    this.receiverSuspenders = [];

    this.wait = wait || 0;
    this.resetTimer(Date.now());
    this.releasingTime = 0;

    this.trailingEdgeTimeout = null;
}

SignalChannel.prototype = copy({

    receive: function() {
        return (new Suspender()).pushToArray(this.receiverSuspenders);
    },

    send: function(data) {
        if (this.closed) { throw 'closed channel' }

        var
        me        = this,
        now       = Date.now(),
        remaining = this.releasingTime - now;

        clearTimeout(this.trailingEdgeTimeout);

        if (remaining <= 0) {
            Suspender.releaseAll(this.receiverSuspenders, this.encode(this.decode(data)));
            this.resetTimer(now);
        } else {
            this.trailingEdgeTimeout = setTimeout(function() {
                Suspender.releaseAll(me.receiverSuspenders, this.encode(this.decode(data)));
                me.resetTimer(Date.now());
            }, remaining);
        }
    },

    resetTimer: function(now) {
        this.previousTime  = now;
        this.releasingTime = this.wait + this.previousTime;
    },

}, Object.create(Channel.prototype));


// aryn lib
function copy(from, to, own) {
    for (var name in from) {
        if (own === true) {
            if (from.hasOwnProperty(name)) {
                to[name] = from[name];
            }
        }
        else {
            to[name] = from[name];
        }
    }

    return to;
}

function isFunction(fn) {
    return typeof fn === 'function';
}

function isChannel(ch) {
    return ch instanceof Channel;
}

function isPromise(pr) {
    return pr && typeof pr.then === 'function';
}

function isGeneratorFunction(obj) {
    var
    constr,
    proto;

    if (obj === void 0) { return false }
    constr = obj.constructor;
    if (! constr) { return false }
    if ((constr.name || constr.displayName) === 'GeneratorFunction') {
        return true;
    }
    proto = constr.prototype;
    return (typeof proto.next == 'function' && typeof proto.throw == 'function');
}

function filter(filter) {
    if (filter === void 0) {
        return function filter(){
            return slice.call(arguments);
        }
    }

    if (typeof filter === 'function') {
        return filter;
    }

    if (!isNaN(filter)) {
        return function singleArgFilter(val) {
            return val[filter];
        }
    }

    if (filter.length !== void 0) {
        return function arrayToObject(val) {
            var i, ret = {};
            for (i = 0; i < filter.length; i++) {
                ret[filter[i]] = val[i];
            }
            return ret;
        }
    }
}

function wrap(generator, forever) {
    return function run() {
        var
        runner = new Runner(generator);
        runner.forever = !!forever;
        runner.run.apply(runner, arguments);
        return runner;
    }
}

var eventFunctionNames = [
    'addEventListener',
    'attachEvent',
    'on',
];

var API = {

    filter: filter,

    runner: function runner(generator, forever) {        
        return wrap(generator, forever);
    },

    run: function run(gen) {
        var args = slice.call(arguments, 1);

        if (gen instanceof Runner) {
            return wrap(gen.generator, gen.forever).apply(this, args);
        }
        return wrap(gen, false).apply(this, slice.call(arguments, 1));
    },

    forever: function forever(gen) {
        var args = slice.call(arguments, 1);

        if (gen instanceof Runner) {
            return wrap(gen.generator, true).apply(this, args);
        }
        return wrap(gen, true).apply(this, args);
    },

    suspend: function suspend(t) {
        return new Suspender(t);
    },

    chan: function chan(size) {
        var ch;
        if (size instanceof Buffer) {
            ch = new Channel(size);
        } else if (isNaN(size)) {
            ch = new Channel();
        } else {
            ch = new Channel(new Buffer(size));
        }
        return ch;
    },

    signal: function signal(wait) {
        return new SignalChannel(wait);
    },

    sender: function sender(chan, filtr) {
        if (! isChannel(cha)) { throw 'invalid channel' }            
        filtr = filter(filtr || 0);
        return function sender() {
            chan.send(filtr(arguments));
        }
    },

    send: function send(chan, value) {
        if (isChannel(chan)) {
            return chan.send(value);
        } else {
            throw 'invalid channel';
        }
    },

    receive: function receive(obj) {
        var susp;

        if (isChannel(obj)) {            
            susp = obj.receive();
        } else if (isPromise(obj)) {
            susp = new Suspender();
            obj.then(function receive(v) { susp.release(v) })
        } else if (obj instanceof Runner) {
            susp = new Suspender();
            obj.done = function receive(v) { susp.release(v) }
        } else {
            throw 'invalid object to receive from';
        }

        return susp;
    },

    close: function close(chan) {
        if (isChannel(chan)) {
            return chan.close();
        } else {
            throw 'invalid channel';
        }
    },

    listen: function listen(obj, eventName, chan, filtr) {
        var name, i, isRegistered,
        len = eventFunctionNames.length;

        filtr = filter(filtr || 0);

        if (! isChannel(chan)) { throw 'invalid channel' }
        if (! obj) { throw 'invalid object' }

        for (i = 0; i < len; i++) {
            name = eventFunctionNames[i];                
            if (typeof obj[name] === 'function') {
                obj[name](eventName, function EventListener() {
                    aryn.send(chan, filtr(arguments));
                });
                isRegistered = true;
                break;
            }
        }

        if (! isRegistered) {
            throw 'the object provided must have one of the following functions: "'
            + eventFunctionNames.join('", "') + '"';
        }

        return chan;
    }
};

global.aryn = {
    API                : API,    
    copy               : copy,
    eventFunctionNames : eventFunctionNames,

    Suspender          : Suspender,
    Runner             : Runner,
    Channel            : Channel,
    SignalChannel      : SignalChannel,

    global: function _global() {
        copy(API, global, true);
    },

    debug: function debug(d) {
        Runner.prototype.debug = !!d;
    },

    module: function module(fn) {
        if (! isFunction(fn)) { throw 'module must be a function' }

        var
        i, parsed,
        params, param,
        args = [],
        str  = String(fn);

        parsed = /\(([\w,\s]+)\)/.exec(str);
        if (parsed) {
            params = parsed[1].replace(/\s+/g, '').split(',');
        }

        if (params) {
            for (i = 0; i < params.length; i++) {
                param = params[i];
                if (API.hasOwnProperty(param)) {
                    args.push(API[param]);
                } else {
                    args.push(void 0);
                }
            }
        }

        fn.apply({}, args);
    }
}

copy(API, global.aryn);

})(this);