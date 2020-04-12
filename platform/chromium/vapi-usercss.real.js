/*******************************************************************************

    uBlock Origin - a browser extension to block requests.
    Copyright (C) 2017-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

'use strict';

// Packaging this file is optional: it is not necessary to package it if the
// platform is known to not support user stylesheets.

// >>>>>>>> start of HUGE-IF-BLOCK
if ( typeof vAPI === 'object' && vAPI.supportsUserStylesheets ) {

/******************************************************************************/
/******************************************************************************/

vAPI.userStylesheet = {
    added: new Set(),
    removed: new Set(),
    apply: function(callback) {
        if ( this.added.size === 0 && this.removed.size === 0 ) { return; }
        vAPI.messaging.send('vapi', {
            what: 'userCSS',
            add: Array.from(this.added),
            remove: Array.from(this.removed),
        }).then(( ) => {
            if ( callback instanceof Function === false ) { return; }
            callback();
        });
        this.added.clear();
        this.removed.clear();
    },
    add: function(cssText, now) {
        if ( cssText === '' ) { return; }
        this.added.add(cssText);
        if ( now ) { this.apply(); }
    },
    remove: function(cssText, now) {
        if ( cssText === '' ) { return; }
        this.removed.add(cssText);
        if ( now ) { this.apply(); }
    }
};

/******************************************************************************/

vAPI.DOMFilterer = class {
    constructor() {
        this.commitTimer = new vAPI.SafeAnimationFrame(this.commitNow.bind(this));
        this.domIsReady = document.readyState !== 'loading';
        this.disabled = false;
        this.listeners = [];
        this.filterset = new Set();
        this.excludedNodeSet = new WeakSet();
        this.addedCSSRules = new Set();
        this.exceptedCSSRules = [];
        this.reOnlySelectors = /\n\{[^\n]+/g;

        // https://github.com/uBlockOrigin/uBlock-issues/issues/167
        //   By the time the DOMContentLoaded is fired, the content script might
        //   have been disconnected from the background page. Unclear why this
        //   would happen, so far seems to be a Chromium-specific behavior at
        //   launch time.
        if ( this.domIsReady !== true ) {
            document.addEventListener('DOMContentLoaded', ( ) => {
                if ( vAPI instanceof Object === false ) { return; }
                this.domIsReady = true;
                this.commit();
            });
        }
    }

    // Here we will deal with:
    // - Injecting low priority user styles;
    // - Notifying listeners about changed filterset.
    // https://www.reddit.com/r/uBlockOrigin/comments/9jj0y1/no_longer_blocking_ads/
    //   Ensure vAPI is still valid -- it can go away by the time we are
    //   called, since the port could be force-disconnected from the main
    //   process. Another approach would be to have vAPI.SafeAnimationFrame
    //   register a shutdown job: to evaluate. For now I will keep the fix
    //   trivial.
    commitNow() {
        this.commitTimer.clear();
        if ( vAPI instanceof Object === false ) { return; }
        const userStylesheet = vAPI.userStylesheet;
        for ( const entry of this.addedCSSRules ) {
            if (
                this.disabled === false &&
                entry.lazy &&
                entry.injected === false
            ) {
                userStylesheet.add(
                    entry.selectors + '\n{' + entry.declarations + '}'
                );
            }
        }
        this.addedCSSRules.clear();
        userStylesheet.apply();
    }

    commit(commitNow) {
        if ( commitNow ) {
            this.commitTimer.clear();
            this.commitNow();
        } else {
            this.commitTimer.start();
        }
    }

    addCSSRule(selectors, declarations, details = {}) {
        if ( selectors === undefined ) { return; }
        const selectorsStr = Array.isArray(selectors)
                ? selectors.join(',\n')
                : selectors;
        if ( selectorsStr.length === 0 ) { return; }
        const entry = {
            selectors: selectorsStr,
            declarations,
            lazy: details.lazy === true,
            injected: details.injected === true
        };
        this.addedCSSRules.add(entry);
        this.filterset.add(entry);
        if (
            this.disabled === false &&
            entry.lazy !== true &&
            entry.injected !== true
        ) {
            vAPI.userStylesheet.add(selectorsStr + '\n{' + declarations + '}');
        }
        this.commit();
        if ( details.silent !== true && this.hasListeners() ) {
            this.triggerListeners({
                declarative: [ [ selectorsStr, declarations ] ]
            });
        }
    }

    exceptCSSRules(exceptions) {
        if ( exceptions.length === 0 ) { return; }
        this.exceptedCSSRules.push(...exceptions);
        if ( this.hasListeners() ) {
            this.triggerListeners({ exceptions });
        }
    }

    addListener(listener) {
        if ( this.listeners.indexOf(listener) !== -1 ) { return; }
        this.listeners.push(listener);
    }

    removeListener(listener) {
        const pos = this.listeners.indexOf(listener);
        if ( pos === -1 ) { return; }
        this.listeners.splice(pos, 1);
    }

    hasListeners() {
        return this.listeners.length !== 0;
    }

    triggerListeners(changes) {
        for ( const listener of this.listeners ) {
            listener.onFiltersetChanged(changes);
        }
    }

    excludeNode(node) {
        this.excludedNodeSet.add(node);
        this.unhideNode(node);
    }

    unexcludeNode(node) {
        this.excludedNodeSet.delete(node);
    }

    hideNode(node) {
        if ( this.excludedNodeSet.has(node) ) { return; }
        if ( this.hideNodeAttr === undefined ) { return; }
        node.setAttribute(this.hideNodeAttr, '');
        if ( this.hideNodeStyleSheetInjected ) { return; }
        this.hideNodeStyleSheetInjected = true;
        this.addCSSRule(
            `[${this.hideNodeAttr}]`,
            'display:none!important;',
            { silent: true }
        );
    }

    unhideNode(node) {
        if ( this.hideNodeAttr === undefined ) { return; }
        node.removeAttribute(this.hideNodeAttr);
    }

    toggle(state, callback) {
        if ( state === undefined ) { state = this.disabled; }
        if ( state !== this.disabled ) { return; }
        this.disabled = !state;
        const userStylesheet = vAPI.userStylesheet;
        for ( const entry of this.filterset ) {
            const rule = `${entry.selectors}\n{${entry.declarations}}`;
            if ( this.disabled ) {
                userStylesheet.remove(rule);
            } else {
                userStylesheet.add(rule);
            }
        }
        userStylesheet.apply(callback);
    }

    getAllSelectors_(all) {
        const out = {
            declarative: [],
            exceptions: this.exceptedCSSRules,
        };
        for ( const entry of this.filterset ) {
            let selectors = entry.selectors;
            if ( all !== true && this.hideNodeAttr !== undefined ) {
                selectors = selectors
                                .replace(`[${this.hideNodeAttr}]`, '')
                                .replace(/^,\n|,\n$/gm, '');
                if ( selectors === '' ) { continue; }
            }
            out.declarative.push([ selectors, entry.declarations ]);
        }
        return out;
    }

    getFilteredElementCount() {
        const details = this.getAllSelectors_(true);
        if ( Array.isArray(details.declarative) === false ) { return 0; }
        const selectors = details.declarative.map(entry => entry[0]);
        if ( selectors.length === 0 ) { return 0; }
        return document.querySelectorAll(selectors.join(',\n')).length;
    }

    getAllSelectors() {
        return this.getAllSelectors_(false);
    }
};

/******************************************************************************/
/******************************************************************************/

}
// <<<<<<<< end of HUGE-IF-BLOCK








/*******************************************************************************

    DO NOT:
    - Remove the following code
    - Add code beyond the following code
    Reason:
    - https://github.com/gorhill/uBlock/pull/3721
    - uBO never uses the return value from injected content scripts

**/

void 0;
