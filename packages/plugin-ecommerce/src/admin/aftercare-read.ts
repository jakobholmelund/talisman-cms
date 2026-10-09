import {useCallback,useEffect,useRef,useState} from 'react';
import {adminRequest,errorText} from './common';
/** Stale snapshots remain readable but cannot authorize a write. */
export function useAftercareRead<T>(action:string,input:unknown,validate:(value:unknown)=>value is T){
 const payload=JSON.stringify(input),[data,setData]=useState<T|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),sequence=useRef(0),unavailable=useRef(true);
 const load=useCallback(async()=>{const run=++sequence.current;unavailable.current=true;setLoading(true);setError('');try{const result=await adminRequest<unknown>('operations',{action,data:JSON.parse(payload)});if(!validate(result))throw new Error('Incomplete details. Refresh before continuing.');if(run===sequence.current){setData(result);unavailable.current=false;}}catch(cause){if(run===sequence.current)setError(errorText(cause));}finally{if(run===sequence.current)setLoading(false);}},[action,payload,validate]);
 useEffect(()=>{void load();return()=>{sequence.current++;unavailable.current=true;};},[load]);return{data,loading,error,load,unavailable};
}
